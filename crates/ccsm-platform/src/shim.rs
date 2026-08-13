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
        "copilot" => Some(ProviderKind::Copilot),
        _ => None,
    }
}

fn provider_from_identity(name: &str, requested: Option<&str>) -> Option<ProviderKind> {
    match name {
        "claude" => Some(ProviderKind::Claude),
        "codex" => Some(ProviderKind::Codex),
        "copilot" => Some(ProviderKind::Copilot),
        "ccsm-provider" => match requested {
            Some("claude") => Some(ProviderKind::Claude),
            Some("codex") => Some(ProviderKind::Codex),
            Some("copilot") => Some(ProviderKind::Copilot),
            _ => None,
        },
        _ => None,
    }
}

pub fn run_cli_shim(provider: ProviderKind) -> i32 {
    let user_args = env::args_os().skip(1).collect::<Vec<_>>();
    let passthrough = env::var_os(WRAPPER_ACTIVE).is_some();
    let search_path = provider_search_path();
    let real = match resolve_real_cli(provider, &search_path.directories) {
        Ok(path) => path,
        Err(message) => {
            eprintln!("ccsm: {message}");
            return 127;
        }
    };
    let args = if passthrough || !has_hook_context() {
        user_args
    } else {
        let native_session_id = env::var("CCSM_NATIVE_SESSION_ID")
            .ok()
            .filter(|value| !value.is_empty());
        let hook_command = hook_command();
        match provider {
            ProviderKind::Claude => build_claude_args(user_args, &hook_command, native_session_id),
            ProviderKind::Codex => build_codex_args(user_args, &hook_command, native_session_id),
            ProviderKind::Copilot => {
                let Some(plugin_dir) = env::var_os("CCSM_COPILOT_PLUGIN_DIR") else {
                    eprintln!("ccsm: Copilot launch has no runtime Hook plugin");
                    return 2;
                };
                build_copilot_args(user_args, plugin_dir, native_session_id)
            }
            ProviderKind::Shell => user_args,
        }
    };
    launch_real_cli(provider, &real, &args, search_path.value.as_ref())
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
        let reporter = env::var_os("CCSM_HOOK_REPORTER")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("ccsm-hook.exe"));
        windows_hook_command(&reporter)
    }
    #[cfg(not(windows))]
    {
        "ccsm-hook hook report".into()
    }
}

#[cfg(windows)]
fn windows_hook_command(reporter: &Path) -> String {
    format!("\"{}\" hook report", reporter.display())
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
    let mut args = vec!["--enable".into(), "hooks".into()];
    for event in CODEX_HOOK_EVENTS {
        args.push("-c".into());
        args.push(
            format!(
                "hooks.{event}=[{{hooks=[{{type='command',command='{hook_command}',timeout=10}}]}}]"
            )
            .into(),
        );
    }
    // Codex 0.144 evaluates the invocation trust bypass against hook
    // definitions already loaded from preceding CLI config overrides.
    args.push("--dangerously-bypass-hook-trust".into());
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

fn build_copilot_args(
    user_args: Vec<OsString>,
    plugin_dir: OsString,
    native_session_id: Option<String>,
) -> Vec<OsString> {
    let mut args = vec!["--plugin-dir".into(), plugin_dir];
    if !has_explicit_copilot_session_flag(&user_args)
        && let Some(native_session_id) = native_session_id
    {
        args.push(format!("--resume={native_session_id}").into());
    }
    args.extend(user_args);
    args
}

fn has_explicit_copilot_session_flag(args: &[OsString]) -> bool {
    args.iter().any(|argument| {
        let argument = argument.to_string_lossy();
        matches!(
            argument.as_ref(),
            "--resume" | "-r" | "--session-id" | "--continue" | "--connect"
        ) || argument.starts_with("--resume=")
            || argument.starts_with("--session-id=")
            || argument.starts_with("--connect=")
    })
}

fn resolve_real_cli(provider: ProviderKind, directories: &[PathBuf]) -> Result<PathBuf, String> {
    let commands = provider_commands(provider);
    let custom_key = match provider {
        ProviderKind::Claude => "CCSM_REAL_CLAUDE_PATH",
        ProviderKind::Codex => "CCSM_REAL_CODEX_PATH",
        ProviderKind::Copilot => "CCSM_REAL_COPILOT_PATH",
        ProviderKind::Shell => unreachable!(),
    };
    if let Some(custom) = env::var_os(custom_key).map(PathBuf::from)
        && custom.is_file()
    {
        return Ok(custom);
    }
    let self_dir = env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    if let Some(program) = find_cli_in_directories(&commands, directories, self_dir.as_deref()) {
        return Ok(preferred_provider_executable(provider, program));
    }
    Err(format!(
        "{} was not found outside the CCSM shim directory",
        commands.join(" or ")
    ))
}

fn preferred_provider_executable(provider: ProviderKind, program: PathBuf) -> PathBuf {
    if provider != ProviderKind::Copilot || !is_windows_batch(&program) {
        return program;
    }
    copilot_native_candidates(&program)
        .into_iter()
        .find(|candidate| candidate.is_file())
        .unwrap_or(program)
}

#[cfg(windows)]
fn is_windows_batch(program: &Path) -> bool {
    program
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
}

#[cfg(not(windows))]
fn is_windows_batch(_program: &Path) -> bool {
    false
}

#[cfg(windows)]
fn copilot_native_candidates(launcher: &Path) -> Vec<PathBuf> {
    let Some(bin_directory) = launcher.parent() else {
        return Vec::new();
    };
    let platform_package = match std::env::consts::ARCH {
        "x86_64" => "copilot-win32-x64",
        "aarch64" => "copilot-win32-arm64",
        _ => return Vec::new(),
    };
    let packages = bin_directory.join("node_modules").join("@github");
    vec![
        packages
            .join("copilot")
            .join("node_modules")
            .join("@github")
            .join(platform_package)
            .join("copilot.exe"),
        packages.join(platform_package).join("copilot.exe"),
    ]
}

#[cfg(not(windows))]
fn copilot_native_candidates(_launcher: &Path) -> Vec<PathBuf> {
    Vec::new()
}

struct ProviderSearchPath {
    value: Option<OsString>,
    directories: Vec<PathBuf>,
}

fn provider_search_path() -> ProviderSearchPath {
    let mut values = env::var_os("PATH").into_iter().collect::<Vec<_>>();
    #[cfg(windows)]
    values.extend(current_windows_path_values().into_iter().flatten());
    provider_search_path_from_values(values)
}

fn provider_search_path_from_values(values: Vec<OsString>) -> ProviderSearchPath {
    let mut directories: Vec<PathBuf> = Vec::new();
    for directory in values.iter().flat_map(env::split_paths) {
        if !directories
            .iter()
            .any(|existing| same_directory(Some(existing), &directory))
        {
            directories.push(directory);
        }
    }
    let value = join_path_values(&values);
    ProviderSearchPath { value, directories }
}

#[cfg(windows)]
fn join_path_values(values: &[OsString]) -> Option<OsString> {
    let mut joined = OsString::new();
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            joined.push(";");
        }
        joined.push(value);
    }
    (!values.is_empty()).then_some(joined)
}

#[cfg(not(windows))]
fn join_path_values(values: &[OsString]) -> Option<OsString> {
    values.first().cloned()
}

fn find_cli_in_directories(
    commands: &[&str],
    directories: &[PathBuf],
    self_dir: Option<&Path>,
) -> Option<PathBuf> {
    commands.iter().find_map(|command| {
        directories.iter().find_map(|directory| {
            if same_directory(self_dir, directory) {
                return None;
            }
            command_candidates(directory, command)
                .into_iter()
                .find(|candidate| candidate.is_file())
        })
    })
}

#[cfg(windows)]
fn current_windows_path_values() -> [Option<OsString>; 2] {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    [
        read_windows_registry_path(HKEY_CURRENT_USER, "Environment"),
        read_windows_registry_path(
            HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ),
    ]
}

#[cfg(windows)]
fn read_windows_registry_path(
    root: windows_sys::Win32::System::Registry::HKEY,
    subkey: &str,
) -> Option<OsString> {
    use std::{os::windows::ffi::OsStringExt, ptr};

    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        System::Registry::{RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ, RegGetValueW},
    };

    let subkey = subkey.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let value_name = "Path".encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let flags = RRF_RT_REG_EXPAND_SZ | RRF_RT_REG_SZ;
    let mut byte_count = 0_u32;
    let status = unsafe {
        RegGetValueW(
            root,
            subkey.as_ptr(),
            value_name.as_ptr(),
            flags,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut byte_count,
        )
    };
    if status != ERROR_SUCCESS || byte_count == 0 {
        return None;
    }

    let mut buffer = vec![0_u16; (byte_count as usize).div_ceil(2)];
    let status = unsafe {
        RegGetValueW(
            root,
            subkey.as_ptr(),
            value_name.as_ptr(),
            flags,
            ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut byte_count,
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let length = buffer
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(buffer.len());
    Some(OsString::from_wide(&buffer[..length]))
}

fn provider_commands(provider: ProviderKind) -> Vec<&'static str> {
    match provider {
        ProviderKind::Claude => vec!["claude"],
        ProviderKind::Codex => vec!["codex"],
        ProviderKind::Copilot => vec!["copilot"],
        ProviderKind::Shell => Vec::new(),
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

fn launch_real_cli(
    provider: ProviderKind,
    program: &Path,
    args: &[OsString],
    search_path: Option<&OsString>,
) -> i32 {
    let mut command = platform_command(program, args);
    if let Some(search_path) = search_path {
        set_command_path(&mut command, search_path);
    }
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

#[cfg(windows)]
fn set_command_path(command: &mut Command, search_path: &OsString) {
    // Rebuild the inherited block without any differently-cased Path entry.
    // cmd.exe otherwise can select the stale duplicate when an npm .cmd
    // launcher expands its Node runtime from PATH.
    let inherited = env::vars_os()
        .filter(|(key, _)| !key.to_string_lossy().eq_ignore_ascii_case("PATH"))
        .collect::<Vec<_>>();
    command.env_clear();
    command.envs(inherited);
    command.env("PATH", search_path);
}

#[cfg(not(windows))]
fn set_command_path(command: &mut Command, search_path: &OsString) {
    command.env("PATH", search_path);
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
        let last_hook = strings
            .iter()
            .rposition(|value| value.contains("hooks."))
            .expect("inline hook config");
        let bypass = strings
            .iter()
            .position(|value| *value == "--dangerously-bypass-hook-trust")
            .expect("hook trust bypass");
        assert!(
            bypass > last_hook,
            "Codex 0.144 applies the invocation trust bypass only after inline hook definitions"
        );
        assert!(bypass < strings.len() - 2, "bypass must precede resume");
    }

    #[test]
    fn copilot_loads_the_runtime_plugin_and_resumes_exactly() {
        let args = build_copilot_args(
            Vec::new(),
            OsString::from(r"C:\runtime\copilot-hook-plugin"),
            Some("native-session".into()),
        );
        assert_eq!(
            args,
            [
                "--plugin-dir",
                r"C:\runtime\copilot-hook-plugin",
                "--resume=native-session"
            ]
        );
    }

    #[test]
    fn copilot_explicit_session_selection_wins() {
        let args = build_copilot_args(
            vec!["--session-id".into(), "explicit".into()],
            OsString::from("plugin"),
            Some("bound".into()),
        );
        assert_eq!(args, ["--plugin-dir", "plugin", "--session-id", "explicit"]);
    }

    #[test]
    fn built_in_providers_resolve_their_native_commands() {
        assert_eq!(provider_commands(ProviderKind::Codex), ["codex"]);
        assert_eq!(provider_commands(ProviderKind::Claude), ["claude"]);
        assert_eq!(provider_commands(ProviderKind::Copilot), ["copilot"]);
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
        assert_eq!(
            provider_from_identity("ccsm-provider", Some("copilot")),
            Some(ProviderKind::Copilot)
        );
        assert_eq!(provider_from_identity("ccsm-provider", None), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_hook_command_uses_the_absolute_reporter_path() {
        let reporter = Path::new(r"C:\Program Files\CCSM\ccsm-desktop.exe");
        assert_eq!(
            windows_hook_command(reporter),
            r#""C:\Program Files\CCSM\ccsm-desktop.exe" hook report"#
        );
    }

    #[cfg(windows)]
    #[test]
    fn native_claude_is_resolved_from_path() {
        let directory = tempfile::tempdir().unwrap();
        let raw_dir = directory.path().join("raw");
        std::fs::create_dir_all(&raw_dir).unwrap();
        std::fs::write(raw_dir.join("claude.exe"), []).unwrap();
        let commands = provider_commands(ProviderKind::Claude);
        let directories = [raw_dir];
        let resolved = find_cli_in_directories(&commands, &directories, None);
        assert_eq!(resolved, Some(directories[0].join("claude.exe")));
    }

    #[cfg(windows)]
    #[test]
    fn npm_copilot_launcher_prefers_its_packaged_native_binary() {
        let directory = tempfile::tempdir().unwrap();
        let launcher = directory.path().join("copilot.cmd");
        let native = directory.path().join(
            "node_modules/@github/copilot/node_modules/@github/copilot-win32-x64/copilot.exe",
        );
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        std::fs::write(&launcher, []).unwrap();
        std::fs::write(&native, []).unwrap();

        assert_eq!(
            preferred_provider_executable(ProviderKind::Copilot, launcher),
            native
        );
    }

    #[cfg(windows)]
    #[test]
    fn fresh_windows_path_extends_a_stale_inherited_path() {
        let directory = tempfile::tempdir().unwrap();
        let stale_dir = directory.path().join("stale");
        let fresh_dir = directory.path().join("fresh");
        std::fs::create_dir_all(&stale_dir).unwrap();
        std::fs::create_dir_all(&fresh_dir).unwrap();
        std::fs::write(fresh_dir.join("codex.cmd"), []).unwrap();

        let search_path = provider_search_path_from_values(vec![
            stale_dir.as_os_str().to_owned(),
            fresh_dir.as_os_str().to_owned(),
        ]);
        let commands = provider_commands(ProviderKind::Codex);
        let resolved = find_cli_in_directories(&commands, &search_path.directories, None);

        assert_eq!(resolved, Some(fresh_dir.clone().join("codex.cmd")));
        assert!(
            search_path
                .value
                .as_ref()
                .is_some_and(|value| env::split_paths(value).any(|path| path == fresh_dir))
        );
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

    #[cfg(windows)]
    #[test]
    fn installed_copilot_batch_launcher_can_find_its_node_runtime() {
        let search_path = provider_search_path();
        let Ok(program) = resolve_real_cli(ProviderKind::Copilot, &search_path.directories) else {
            return;
        };
        let mut command = platform_command(&program, &[OsString::from("--version")]);
        if let Some(path) = search_path.value.as_ref() {
            set_command_path(&mut command, path);
        }
        command.env("COPILOT_AUTO_UPDATE", "false");
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("GitHub Copilot CLI"));
    }
}
