use std::{
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use ccsm_core::dto::ProviderKind;
use serde_json::{Map, Value, json};
use uuid::Uuid;

const WRAPPER_ACTIVE: &str = "CCSM_WRAPPER_ACTIVE";
const CODEX_HOOK_EVENTS: [&str; 6] = [
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "PreToolUse",
    "Stop",
    "SessionEnd",
];
const CLAUDE_HOOK_EVENTS: [&str; 7] = [
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "PreToolUse",
    "Stop",
    "StopFailure",
    "SessionEnd",
];

pub fn provider_from_executable() -> Option<ProviderKind> {
    let name = env::current_exe()
        .ok()?
        .file_stem()?
        .to_string_lossy()
        .to_ascii_lowercase();
    provider_from_identity(&name, env::var("CCSM_PROVIDER").ok().as_deref())
}

pub fn provider_from_environment() -> Option<ProviderKind> {
    match env::var("CCSM_PROVIDER").ok()?.as_str() {
        "claude" => Some(ProviderKind::Claude),
        "codex" => Some(ProviderKind::Codex),
        _ => None,
    }
}

fn provider_from_identity(name: &str, requested: Option<&str>) -> Option<ProviderKind> {
    match name {
        "claude" => Some(ProviderKind::Claude),
        "codex" => Some(ProviderKind::Codex),
        "ccsm-provider" => match requested {
            Some("claude") => Some(ProviderKind::Claude),
            Some("codex") => Some(ProviderKind::Codex),
            _ => None,
        },
        _ => None,
    }
}

pub fn run_cli_shim(provider: ProviderKind) -> i32 {
    let user_args = env::args_os().skip(1).collect::<Vec<_>>();
    let passthrough = env::var_os(WRAPPER_ACTIVE).is_some();
    let real = match resolve_real_cli(provider, !passthrough) {
        Ok(path) => path,
        Err(message) => {
            eprintln!("ccsm: {message}");
            return 127;
        }
    };
    let mut args = if passthrough || !has_hook_context() {
        user_args
    } else {
        let native_session_id = env::var("CCSM_NATIVE_SESSION_ID")
            .ok()
            .filter(|value| !value.is_empty());
        let hook_command = hook_command();
        match provider {
            ProviderKind::Claude => build_claude_args(user_args, &hook_command, native_session_id),
            ProviderKind::Codex => build_codex_args(user_args, &hook_command, native_session_id),
            ProviderKind::Shell => user_args,
        }
    };
    if !passthrough
        && provider == ProviderKind::Claude
        && real
            .file_stem()
            .is_some_and(|name| name.eq_ignore_ascii_case("ccp"))
    {
        ensure_claude_model(&mut args, configured_ccp_model());
    }
    launch_real_cli(provider, &real, &args)
}

fn ensure_claude_model(args: &mut Vec<OsString>, model: Option<String>) {
    if model.is_none()
        || args.iter().any(|argument| {
            let argument = argument.to_string_lossy();
            matches!(argument.as_ref(), "--model" | "-m") || argument.starts_with("--model=")
        })
    {
        return;
    }
    args.push("--model".into());
    args.push(model.unwrap().into());
}

fn configured_ccp_model() -> Option<String> {
    if let Some(model) = env::var("CCSM_CLAUDE_MODEL")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return Some(model);
    }
    let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    let path = PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("gc2cc")
        .join("ccp.json");
    let config: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    config
        .get("defaultModel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn has_hook_context() -> bool {
    [
        "CCSM_SESSION_ID",
        "CCSM_RUNTIME_ID",
        "CCSM_HOOK_PIPE",
        "CCSM_HOOK_TOKEN",
    ]
    .into_iter()
    .all(|name| env::var_os(name).is_some_and(|value| !value.is_empty()))
}

fn hook_command() -> String {
    #[cfg(windows)]
    {
        "ccsm-hook.exe hook report".into()
    }
    #[cfg(not(windows))]
    {
        "ccsm-hook hook report".into()
    }
}

fn build_claude_args(
    user_args: Vec<OsString>,
    hook_command: &str,
    native_session_id: Option<String>,
) -> Vec<OsString> {
    let (filtered, settings) = collect_claude_settings(user_args);
    let mut merged = claude_hook_settings(hook_command);
    for setting in settings.into_iter().rev() {
        match load_settings(&setting) {
            Ok(user) => deep_merge(&mut merged, user),
            Err(error) => eprintln!("ccsm: ignored invalid Claude --settings: {error}"),
        }
    }
    let mut args = Vec::new();
    if !has_explicit_claude_session_flag(&filtered) {
        if let Some(native_session_id) = native_session_id {
            args.push("--resume".into());
            args.push(native_session_id.into());
        } else {
            args.push("--session-id".into());
            args.push(Uuid::new_v4().to_string().into());
        }
    }
    args.push("--settings".into());
    args.push(merged.to_string().into());
    args.extend(filtered);
    args
}

fn claude_hook_settings(hook_command: &str) -> Value {
    let hooks = CLAUDE_HOOK_EVENTS
        .into_iter()
        .map(|event| {
            (
                event.to_string(),
                json!([{
                    "matcher": "",
                    "hooks": [{
                        "type": "command",
                        "command": hook_command,
                        "timeout": 10
                    }]
                }]),
            )
        })
        .collect::<Map<_, _>>();
    Value::Object(Map::from_iter([(
        "hooks".to_string(),
        Value::Object(hooks),
    )]))
}

fn collect_claude_settings(args: Vec<OsString>) -> (Vec<OsString>, Vec<String>) {
    let mut filtered = Vec::new();
    let mut settings = Vec::new();
    let mut iterator = args.into_iter();
    while let Some(argument) = iterator.next() {
        let text = argument.to_string_lossy();
        if text == "--settings" {
            if let Some(value) = iterator.next() {
                settings.push(value.to_string_lossy().into_owned());
            } else {
                filtered.push(argument);
            }
        } else if let Some(value) = text.strip_prefix("--settings=") {
            settings.push(value.to_string());
        } else {
            filtered.push(argument);
        }
    }
    (filtered, settings)
}

fn load_settings(value: &str) -> Result<Value, String> {
    let trimmed = value.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        return serde_json::from_str(trimmed).map_err(|error| error.to_string());
    }
    let path = expand_home(trimmed);
    let contents = std::fs::read_to_string(&path)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(suffix) = path.strip_prefix("~/")
        && let Some(home) = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
    {
        return PathBuf::from(home).join(suffix);
    }
    PathBuf::from(path)
}

fn deep_merge(base: &mut Value, user: Value) {
    match (base, user) {
        (Value::Array(base), Value::Array(mut user)) => base.append(&mut user),
        (Value::Object(base), Value::Object(user)) => merge_objects(base, user),
        (Value::Array(_), _) | (Value::Object(_), _) => {}
        (base, user) => *base = user,
    }
}

fn merge_objects(base: &mut Map<String, Value>, user: Map<String, Value>) {
    for (key, value) in user {
        if let Some(existing) = base.get_mut(&key) {
            deep_merge(existing, value);
        } else {
            base.insert(key, value);
        }
    }
}

fn has_explicit_claude_session_flag(args: &[OsString]) -> bool {
    args.iter().any(|argument| {
        let argument = argument.to_string_lossy();
        matches!(
            argument.as_ref(),
            "--resume" | "-r" | "--session-id" | "--continue" | "-c"
        ) || argument.starts_with("--resume=")
            || argument.starts_with("--session-id=")
    })
}

fn build_codex_args(
    user_args: Vec<OsString>,
    hook_command: &str,
    native_session_id: Option<String>,
) -> Vec<OsString> {
    let hook_command = hook_command.replace('\'', "");
    let mut args = vec![
        "--enable".into(),
        "hooks".into(),
        "--dangerously-bypass-hook-trust".into(),
    ];
    for event in CODEX_HOOK_EVENTS {
        args.push("-c".into());
        args.push(
            format!(
                "hooks.{event}=[{{hooks=[{{type='command',command='{hook_command}',timeout=10}}]}}]"
            )
            .into(),
        );
    }
    args.push("--no-alt-screen".into());
    if user_args.is_empty()
        && let Some(native_session_id) = native_session_id
    {
        args.push("resume".into());
        args.push(native_session_id.into());
    } else {
        args.extend(user_args);
    }
    args
}

fn resolve_real_cli(
    provider: ProviderKind,
    prefer_local_launcher: bool,
) -> Result<PathBuf, String> {
    let commands = launcher_names(provider, prefer_local_launcher);
    let custom_key = match provider {
        ProviderKind::Claude => "CCSM_REAL_CLAUDE_PATH",
        ProviderKind::Codex => "CCSM_REAL_CODEX_PATH",
        ProviderKind::Shell => unreachable!(),
    };
    if !prefer_local_launcher {
        if let Some(custom) = env::var_os(custom_key).map(PathBuf::from)
            && custom.is_file()
        {
            return Ok(custom);
        }
    }
    let self_dir = env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    let path = env::var_os("PATH").ok_or_else(|| "PATH is not set".to_string())?;
    let directories = env::split_paths(&path).collect::<Vec<_>>();
    for command in &commands {
        for directory in &directories {
            if same_directory(self_dir.as_deref(), directory) {
                continue;
            }
            for candidate in command_candidates(&directory, command) {
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }
    Err(format!(
        "{} was not found outside the CCSM shim directory",
        commands.join(" or ")
    ))
}

fn launcher_names(provider: ProviderKind, prefer_local_launcher: bool) -> Vec<&'static str> {
    match (provider, prefer_local_launcher) {
        (ProviderKind::Claude, true) => vec!["ccp", "claude"],
        (ProviderKind::Codex, true) => vec!["cxp", "codex"],
        (ProviderKind::Claude, false) => vec!["claude"],
        (ProviderKind::Codex, false) => vec!["codex"],
        (ProviderKind::Shell, _) => Vec::new(),
    }
}

fn same_directory(left: Option<&Path>, right: &Path) -> bool {
    let Some(left) = left else {
        return false;
    };
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

#[cfg(windows)]
fn command_candidates(directory: &Path, command: &str) -> Vec<PathBuf> {
    ["exe", "com", "cmd", "bat"]
        .into_iter()
        .map(|extension| directory.join(format!("{command}.{extension}")))
        .collect()
}

#[cfg(not(windows))]
fn command_candidates(directory: &Path, command: &str) -> Vec<PathBuf> {
    vec![directory.join(command)]
}

fn launch_real_cli(provider: ProviderKind, program: &Path, args: &[OsString]) -> i32 {
    let mut command = platform_command(program, args);
    command
        .env(WRAPPER_ACTIVE, "1")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if provider == ProviderKind::Claude
        && let Some(base_url) =
            env::var_os("CCSM_CLAUDE_BASE_URL").filter(|value| !value.is_empty())
    {
        command.env("ANTHROPIC_BASE_URL", base_url);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        let error = command.exec();
        eprintln!("ccsm: launch {} failed: {error}", program.display());
        126
    }
    #[cfg(windows)]
    {
        match command.status() {
            Ok(status) => status.code().unwrap_or(1),
            Err(error) => {
                eprintln!("ccsm: launch {} failed: {error}", program.display());
                126
            }
        }
    }
}

#[cfg(not(windows))]
fn platform_command(program: &Path, args: &[OsString]) -> Command {
    let mut command = Command::new(program);
    command.args(args);
    command
}

#[cfg(windows)]
fn platform_command(program: &Path, args: &[OsString]) -> Command {
    use std::os::windows::process::CommandExt;

    let is_batch = program
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        });
    if !is_batch {
        let mut command = Command::new(program);
        command.args(args);
        return command;
    }
    let shell = env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
    let mut words = Vec::with_capacity(args.len() + 1);
    words.push(quote_windows_command_word(program.as_os_str()));
    words.extend(
        args.iter()
            .map(|argument| quote_windows_command_word(argument)),
    );
    let mut command = Command::new(shell);
    command.args(["/D", "/S", "/C"]);
    command.raw_arg(format!("\"{}\"", words.join(" ")));
    command
}

#[cfg(windows)]
fn quote_windows_command_word(value: &std::ffi::OsStr) -> String {
    let value = value.to_string_lossy();
    let mut result = String::from("\"");
    let mut backslashes = 0;
    for character in value.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                result.push_str(&"\\".repeat(backslashes * 2 + 1));
                result.push('"');
                backslashes = 0;
            }
            _ => {
                result.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                result.push(character);
            }
        }
    }
    result.push_str(&"\\".repeat(backslashes * 2));
    result.push('"');
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_settings_merge_keeps_both_hook_arrays() {
        let args = build_claude_args(
            vec![
                "--settings".into(),
                r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"user"}]}]},"model":"opus"}"#.into(),
            ],
            "ccsm-hook hook report",
            None,
        );
        let settings_index = args
            .iter()
            .position(|argument| argument == "--settings")
            .expect("settings argument");
        let settings: Value = serde_json::from_str(&args[settings_index + 1].to_string_lossy())
            .expect("merged settings JSON");
        assert_eq!(settings["model"], "opus");
        assert_eq!(
            settings["hooks"]["SessionStart"].as_array().unwrap().len(),
            2
        );
        for event in CLAUDE_HOOK_EVENTS {
            assert!(settings["hooks"][event].is_array(), "missing {event}");
        }
        assert!(args.iter().any(|argument| argument == "--session-id"));
    }

    #[test]
    fn claude_bound_session_resumes_without_preallocating_an_id() {
        let args = build_claude_args(Vec::new(), "ccsm-hook hook report", Some("native".into()));
        assert_eq!(args[0], "--resume");
        assert_eq!(args[1], "native");
        assert!(!args.iter().any(|argument| argument == "--session-id"));
    }

    #[test]
    fn codex_hook_flags_precede_resume() {
        let args = build_codex_args(Vec::new(), "ccsm-hook hook report", Some("native".into()));
        let strings = args
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>();
        assert_eq!(strings[strings.len() - 2], "resume");
        assert_eq!(strings[strings.len() - 1], "native");
        assert!(
            strings
                .iter()
                .any(|value| value.contains("hooks.SessionStart"))
        );
        assert!(
            strings
                .iter()
                .any(|value| value.contains("hooks.UserPromptSubmit"))
        );
        for event in CODEX_HOOK_EVENTS {
            assert!(
                strings
                    .iter()
                    .any(|value| value.contains(&format!("hooks.{event}"))),
                "missing {event}"
            );
        }
        assert!(
            !strings
                .iter()
                .any(|value| value.contains("hooks.StopFailure")),
            "Codex must not receive the Claude-only StopFailure hook"
        );
    }

    #[test]
    fn local_provider_launchers_are_used_only_for_the_outer_shim() {
        assert_eq!(launcher_names(ProviderKind::Codex, true), ["cxp", "codex"]);
        assert_eq!(launcher_names(ProviderKind::Codex, false), ["codex"]);
        assert_eq!(
            launcher_names(ProviderKind::Claude, true),
            ["ccp", "claude"]
        );
        assert_eq!(launcher_names(ProviderKind::Claude, false), ["claude"]);
    }

    #[test]
    fn ccp_model_is_explicit_without_overriding_a_user_choice() {
        let mut args = vec![OsString::from("--settings"), OsString::from("hooks.json")];
        ensure_claude_model(&mut args, Some("gpt-5.6-sol[1m]".into()));
        assert_eq!(args[args.len() - 2], "--model");
        assert_eq!(args[args.len() - 1], "gpt-5.6-sol[1m]");

        let mut explicit = vec![OsString::from("--model"), OsString::from("custom")];
        ensure_claude_model(&mut explicit, Some("default".into()));
        assert_eq!(explicit, ["--model", "custom"]);
    }

    #[test]
    fn neutral_runtime_shim_uses_the_provider_environment() {
        assert_eq!(
            provider_from_identity("ccsm-provider", Some("codex")),
            Some(ProviderKind::Codex)
        );
        assert_eq!(
            provider_from_identity("ccsm-provider", Some("claude")),
            Some(ProviderKind::Claude)
        );
        assert_eq!(provider_from_identity("ccsm-provider", None), None);
    }

    #[cfg(windows)]
    #[test]
    fn preferred_launcher_wins_even_when_raw_cli_is_earlier_on_path() {
        let directory = tempfile::tempdir().unwrap();
        let raw_dir = directory.path().join("raw");
        let launcher_dir = directory.path().join("launcher");
        std::fs::create_dir_all(&raw_dir).unwrap();
        std::fs::create_dir_all(&launcher_dir).unwrap();
        std::fs::write(raw_dir.join("claude.exe"), []).unwrap();
        std::fs::write(launcher_dir.join("ccp.cmd"), []).unwrap();
        let commands = launcher_names(ProviderKind::Claude, true);
        let directories = [raw_dir, launcher_dir.clone()];
        let resolved = commands.iter().find_map(|command| {
            directories.iter().find_map(|directory| {
                command_candidates(directory, command)
                    .into_iter()
                    .find(|candidate| candidate.is_file())
            })
        });
        assert_eq!(resolved, Some(launcher_dir.join("ccp.cmd")));
    }

    #[cfg(windows)]
    #[test]
    fn batch_launcher_preserves_a_spaced_argument() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("launcher.cmd");
        std::fs::write(
            &script,
            "@echo off\r\nif \"%~1\"==\"hello world\" exit /b 0\r\nexit /b 9\r\n",
        )
        .unwrap();
        let status = platform_command(&script, &[OsString::from("hello world")])
            .status()
            .unwrap();
        assert!(status.success());
    }
}
