use std::{
    collections::HashMap,
    env,
    fs::{OpenOptions, read_to_string},
    io::{self, BufRead, Write},
    path::PathBuf,
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::json;

const MOCK_ENABLED: &str = "CCSM_E2E_MODEL_MOCK";
const MOCK_CONFIG: &str = "CCSM_E2E_MODEL_MOCK_FILE";
const MOCK_LOG: &str = "CCSM_E2E_MODEL_MOCK_LOG";

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelMockConfig {
    default_response: Option<String>,
    #[serde(default)]
    providers: HashMap<String, HashMap<String, String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelMockEvent<'a> {
    timestamp_ms: u128,
    event: &'a str,
    provider: &'a str,
    cli_session_id: &'a str,
    native_session_id: &'a str,
    resumed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    arguments: Option<&'a [String]>,
}

pub fn is_enabled() -> bool {
    env::var(MOCK_ENABLED).as_deref() == Ok("1")
        && env::var("CCSM_WRAPPER_ACTIVE").as_deref() == Ok("1")
        && env::var_os("CCSM_PROVIDER").is_some()
}

pub fn run() -> i32 {
    match run_inner() {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("CCSM E2E provider mock failed: {error}");
            1
        }
    }
}

fn run_inner() -> Result<(), String> {
    let provider = required_env("CCSM_PROVIDER")?;
    let cli_session_id = required_env("CCSM_SESSION_ID")?;
    let resumed_session_id = env::var("CCSM_NATIVE_SESSION_ID")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let resumed = resumed_session_id.is_some();
    let native_session_id =
        resumed_session_id.unwrap_or_else(|| format!("ccsm-e2e-{provider}-{cli_session_id}"));
    let arguments = env::args().skip(1).collect::<Vec<_>>();

    report_hook(&native_session_id, "SessionStart")?;
    append_event(ModelMockEvent {
        timestamp_ms: timestamp_ms(),
        event: "session-start",
        provider: &provider,
        cli_session_id: &cli_session_id,
        native_session_id: &native_session_id,
        resumed,
        prompt: None,
        response: None,
        arguments: Some(&arguments),
    })?;

    println!(
        "CCSM E2E {provider} mock {} session {native_session_id}",
        if resumed { "resumed" } else { "started" }
    );
    print!("CCSM_E2E_READY> ");
    io::stdout().flush().map_err(|error| error.to_string())?;

    for line in io::stdin().lock().lines() {
        let line = line.map_err(|error| format!("read mock prompt: {error}"))?;
        let prompt = normalize_prompt(&line);
        if prompt.is_empty() {
            print!("CCSM_E2E_READY> ");
            io::stdout().flush().map_err(|error| error.to_string())?;
            continue;
        }

        report_hook(&native_session_id, "UserPromptSubmit")?;
        let response = model_response(&provider, &prompt)?;
        append_event(ModelMockEvent {
            timestamp_ms: timestamp_ms(),
            event: "model-response",
            provider: &provider,
            cli_session_id: &cli_session_id,
            native_session_id: &native_session_id,
            resumed,
            prompt: Some(&prompt),
            response: Some(&response),
            arguments: None,
        })?;
        println!("\r\n{response}");
        report_hook(&native_session_id, "Stop")?;
        print!("CCSM_E2E_READY> ");
        io::stdout().flush().map_err(|error| error.to_string())?;
    }

    let _ = report_hook(&native_session_id, "SessionEnd");
    Ok(())
}

fn required_env(name: &str) -> Result<String, String> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} is required"))
}

fn normalize_prompt(input: &str) -> String {
    input
        .replace("\u{1b}[200~", "")
        .replace("\u{1b}[201~", "")
        .trim_matches(|character: char| character.is_control() || character.is_whitespace())
        .to_string()
}

fn model_response(provider: &str, prompt: &str) -> Result<String, String> {
    let path = env::var_os(MOCK_CONFIG)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{MOCK_CONFIG} is required"))?;
    let contents = read_to_string(&path)
        .map_err(|error| format!("read model mock config {}: {error}", path.display()))?;
    let config: ModelMockConfig = serde_json::from_str(&contents)
        .map_err(|error| format!("parse model mock config {}: {error}", path.display()))?;
    response_from_config(&config, provider, prompt).ok_or_else(|| {
        format!("no model mock response configured for provider={provider} prompt={prompt:?}")
    })
}

fn response_from_config(config: &ModelMockConfig, provider: &str, prompt: &str) -> Option<String> {
    config
        .providers
        .get(provider)
        .and_then(|responses| responses.get(prompt))
        .cloned()
        .or_else(|| config.default_response.clone())
}

fn report_hook(native_session_id: &str, hook_event_name: &str) -> Result<(), String> {
    let reporter = PathBuf::from(required_env("CCSM_HOOK_REPORTER")?);
    let mut child = Command::new(&reporter)
        .args(["hook", "report"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("start Hook reporter {}: {error}", reporter.display()))?;
    let payload = json!({
        "session_id": native_session_id,
        "hook_event_name": hook_event_name,
    });
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Hook reporter stdin is unavailable".to_string())?;
    serde_json::to_writer(&mut stdin, &payload)
        .map_err(|error| format!("encode Hook payload: {error}"))?;
    stdin
        .write_all(b"\n")
        .map_err(|error| format!("write Hook payload: {error}"))?;
    drop(stdin);
    let output = child
        .wait_with_output()
        .map_err(|error| format!("wait for Hook reporter: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Hook reporter rejected {hook_event_name}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn append_event(event: ModelMockEvent<'_>) -> Result<(), String> {
    let path = env::var_os(MOCK_LOG)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{MOCK_LOG} is required"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("open model mock log {}: {error}", path.display()))?;
    serde_json::to_writer(&mut file, &event)
        .map_err(|error| format!("encode model mock event: {error}"))?;
    file.write_all(b"\n")
        .map_err(|error| format!("write model mock event: {error}"))
}

fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_prompt_response_overrides_the_default() {
        let config = ModelMockConfig {
            default_response: Some("default".into()),
            providers: HashMap::from([(
                "codex".into(),
                HashMap::from([("hello".into(), "codex reply".into())]),
            )]),
        };

        assert_eq!(
            response_from_config(&config, "codex", "hello").as_deref(),
            Some("codex reply")
        );
        assert_eq!(
            response_from_config(&config, "claude", "hello").as_deref(),
            Some("default")
        );
    }

    #[test]
    fn prompt_normalization_removes_bracketed_paste_markers() {
        assert_eq!(normalize_prompt("\u{1b}[200~ hello \u{1b}[201~\r"), "hello");
    }
}
