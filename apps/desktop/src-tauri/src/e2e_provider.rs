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
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let recorded_arguments = session_selection_arguments(&provider, &arguments);
    let resumed_session_id = env::var("CCSM_NATIVE_SESSION_ID")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let resumed = resumed_session_id.is_some();
    let mut native_session_id = if let Some(session_id) = resumed_session_id {
        validate_resume_invocation(&provider, &arguments, &session_id)?;
        Some(session_id)
    } else if provider == "claude" {
        Some(
            argument_value(&arguments, "--session-id")
                .ok_or_else(|| "Claude mock invocation has no --session-id".to_string())?,
        )
    } else {
        None
    };

    if let Some(session_id) = native_session_id.as_deref() {
        start_session(
            &provider,
            &cli_session_id,
            session_id,
            resumed,
            &recorded_arguments,
        )?;
    }

    println!(
        "CCSM E2E {provider} mock {} session {}",
        if resumed { "resumed" } else { "started" },
        native_session_id.as_deref().unwrap_or("pending")
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

        if native_session_id.is_none() {
            let session_id = format!("ccsm-e2e-{provider}-{cli_session_id}");
            start_session(
                &provider,
                &cli_session_id,
                &session_id,
                false,
                &recorded_arguments,
            )?;
            native_session_id = Some(session_id);
        }
        let session_id = native_session_id
            .as_deref()
            .ok_or_else(|| "model mock session binding is unavailable".to_string())?;
        report_hook(session_id, "UserPromptSubmit")?;
        let response = model_response(&provider, &prompt)?;
        append_event(ModelMockEvent {
            timestamp_ms: timestamp_ms(),
            event: "model-response",
            provider: &provider,
            cli_session_id: &cli_session_id,
            native_session_id: session_id,
            resumed,
            prompt: Some(&prompt),
            response: Some(&response),
            arguments: None,
        })?;
        println!("\r\n{response}");
        report_hook(session_id, "Stop")?;
        print!("CCSM_E2E_READY> ");
        io::stdout().flush().map_err(|error| error.to_string())?;
    }

    if let Some(session_id) = native_session_id.as_deref() {
        let _ = report_hook(session_id, "SessionEnd");
    }
    Ok(())
}

fn start_session(
    provider: &str,
    cli_session_id: &str,
    native_session_id: &str,
    resumed: bool,
    arguments: &[String],
) -> Result<(), String> {
    report_hook(native_session_id, "SessionStart")?;
    append_event(ModelMockEvent {
        timestamp_ms: timestamp_ms(),
        event: "session-start",
        provider,
        cli_session_id,
        native_session_id,
        resumed,
        prompt: None,
        response: None,
        arguments: Some(arguments),
    })
}

fn argument_value(arguments: &[String], name: &str) -> Option<String> {
    arguments.iter().enumerate().find_map(|(index, argument)| {
        if argument == name {
            arguments.get(index + 1).cloned()
        } else {
            argument
                .strip_prefix(&format!("{name}="))
                .map(str::to_string)
        }
    })
}

fn validate_resume_invocation(
    provider: &str,
    arguments: &[String],
    native_session_id: &str,
) -> Result<(), String> {
    let matches = match provider {
        "claude" => argument_value(arguments, "--resume").as_deref() == Some(native_session_id),
        "codex" => arguments
            .windows(2)
            .any(|pair| pair[0] == "resume" && pair[1] == native_session_id),
        "copilot" => argument_value(arguments, "--resume").as_deref() == Some(native_session_id),
        _ => false,
    };
    if matches {
        Ok(())
    } else {
        Err(format!(
            "{provider} resume invocation does not contain native session {native_session_id}"
        ))
    }
}

fn session_selection_arguments(provider: &str, arguments: &[String]) -> Vec<String> {
    let split_argument = |name: &str| {
        arguments
            .iter()
            .position(|argument| argument == name)
            .and_then(|index| arguments.get(index + 1).map(|value| (index, value)))
            .map(|(_, value)| vec![name.to_string(), value.clone()])
            .or_else(|| {
                arguments
                    .iter()
                    .find(|argument| argument.starts_with(&format!("{name}=")))
                    .map(|argument| vec![argument.clone()])
            })
    };
    match provider {
        "claude" => split_argument("--resume")
            .or_else(|| split_argument("--session-id"))
            .unwrap_or_default(),
        "codex" => arguments
            .windows(2)
            .find(|pair| pair[0] == "resume")
            .map(|pair| pair.to_vec())
            .unwrap_or_default(),
        "copilot" => split_argument("--resume").unwrap_or_default(),
        _ => Vec::new(),
    }
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

    #[test]
    fn extracts_split_and_joined_argument_values() {
        assert_eq!(
            argument_value(&["--session-id".into(), "native-1".into()], "--session-id").as_deref(),
            Some("native-1")
        );
        assert_eq!(
            argument_value(&["--resume=native-2".into()], "--resume").as_deref(),
            Some("native-2")
        );
    }

    #[test]
    fn validates_each_provider_resume_shape() {
        assert!(
            validate_resume_invocation(
                "claude",
                &["--resume".into(), "native-1".into()],
                "native-1"
            )
            .is_ok()
        );
        assert!(
            validate_resume_invocation("codex", &["resume".into(), "native-1".into()], "native-1")
                .is_ok()
        );
        assert!(
            validate_resume_invocation("copilot", &["--resume=native-1".into()], "native-1")
                .is_ok()
        );
        assert!(validate_resume_invocation("codex", &[], "native-1").is_err());
    }

    #[test]
    fn records_only_provider_session_selection_arguments() {
        assert_eq!(
            session_selection_arguments(
                "claude",
                &[
                    "--settings".into(),
                    "sensitive-hook-config".into(),
                    "--resume".into(),
                    "native-1".into(),
                ],
            ),
            ["--resume", "native-1"]
        );
        assert_eq!(
            session_selection_arguments(
                "codex",
                &[
                    "-c".into(),
                    "sensitive-hook-config".into(),
                    "resume".into(),
                    "native-1".into(),
                ],
            ),
            ["resume", "native-1"]
        );
        assert_eq!(
            session_selection_arguments(
                "copilot",
                &[
                    "--plugin-dir".into(),
                    "sensitive-path".into(),
                    "--resume=native-1".into(),
                ],
            ),
            ["--resume=native-1"]
        );
    }
}
