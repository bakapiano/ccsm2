use std::io::{self, BufRead, Write};

use ccsm_core::{
    dto::{BoardChangeReport, ProviderKind},
    error::{BackendError, BackendResult},
    ports::BoardStore,
};
use serde_json::{Value, json};

use crate::{board::LocalBoardStore, hook::send_board_change_report};

pub fn run_board_mcp_server() -> i32 {
    match run_server() {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("ccsm Board MCP failed: {error}");
            1
        }
    }
}

fn run_server() -> BackendResult<()> {
    let root = required_env("CCSM_BOARD_ROOT")?;
    let context = BoardMcpContext {
        store: LocalBoardStore::open(root.into())?,
        provider: parse_provider(&required_env("CCSM_PROVIDER")?)?,
        space_id: required_env("CCSM_SPACE_ID")?,
        cli_session_id: required_env("CCSM_SESSION_ID")?,
        runtime_id: required_env("CCSM_RUNTIME_ID")?,
        token: required_env("CCSM_HOOK_TOKEN")?,
    };
    let input = io::stdin();
    let mut output = io::stdout().lock();
    for line in input.lock().lines() {
        let line = line.map_err(|error| BackendError::Platform(error.to_string()))?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                write_message(
                    &mut output,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": null,
                        "error": {"code": -32700, "message": format!("parse error: {error}")}
                    }),
                )?;
                continue;
            }
        };
        if let Some(response) = handle_request(&context, &request) {
            write_message(&mut output, &response)?;
        }
    }
    Ok(())
}

struct BoardMcpContext {
    store: LocalBoardStore,
    provider: ProviderKind,
    space_id: String,
    cli_session_id: String,
    runtime_id: String,
    token: String,
}

fn handle_request(context: &BoardMcpContext, request: &Value) -> Option<Value> {
    let method = request.get("method")?.as_str()?;
    let id = request.get("id").cloned();
    if id.is_none() {
        return None;
    }
    let id = id.unwrap_or(Value::Null);
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": request
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2025-06-18"),
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {
                "name": "ccsm",
                "version": env!("CARGO_PKG_VERSION")
            },
            "instructions": "Create interactive visual boards with board_put. Each board is one complete HTML document with a <title>, responsive CSS, and optional JavaScript or version-pinned browser ESM imports. Use board_list and board_get before updating an existing board."
        })),
        "ping" | "logging/setLevel" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": board_tools()})),
        "tools/call" => tool_call(context, request.get("params").unwrap_or(&Value::Null)),
        _ => {
            return Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {"code": -32601, "message": format!("method not found: {method}")}
            }));
        }
    };
    Some(match result {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err(error) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "content": [{"type": "text", "text": error.to_string()}],
                "isError": true
            }
        }),
    })
}

fn board_tools() -> Vec<Value> {
    vec![
        json!({
            "name": "board_list",
            "title": "List CCSM boards",
            "description": "List every HTML board in the current CCSM Space. Returns compact metadata and revisions.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
            "annotations": {"readOnlyHint": true, "idempotentHint": true}
        }),
        json!({
            "name": "board_get",
            "title": "Read a CCSM board",
            "description": "Read one board's complete HTML and current revision before making a targeted update.",
            "inputSchema": {
                "type": "object",
                "properties": {"boardId": {"type": "string"}},
                "required": ["boardId"],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": true, "idempotentHint": true}
        }),
        json!({
            "name": "board_put",
            "title": "Create or update a CCSM board",
            "description": "Create a board or replace an existing board with one complete UTF-8 HTML document. Include a concise <title>. JavaScript interactions stay inside the board. Existing boards should include expectedRevision from board_get.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "boardId": {"type": "string", "description": "Stable letters/numbers/hyphens/underscores ID. Omit to create a UUID."},
                    "html": {"type": "string", "description": "Complete HTML document, up to 2 MiB."},
                    "expectedRevision": {"type": "string", "description": "Revision returned by board_get for updates."}
                },
                "required": ["html"],
                "additionalProperties": false
            },
            "annotations": {"destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
        }),
    ]
}

fn tool_call(context: &BoardMcpContext, params: &Value) -> BackendResult<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| BackendError::Invalid("MCP tool call has no name".into()))?;
    let arguments = params.get("arguments").unwrap_or(&Value::Null);
    let value = match name {
        "board_list" => serde_json::to_value(context.store.list(&context.space_id)?)
            .map_err(|error| BackendError::Platform(error.to_string()))?,
        "board_get" => {
            let board_id = required_argument(arguments, "boardId")?;
            serde_json::to_value(context.store.read(&context.space_id, board_id)?)
                .map_err(|error| BackendError::Platform(error.to_string()))?
        }
        "board_put" => {
            let html = required_argument(arguments, "html")?;
            let document = context.store.put(
                &context.space_id,
                optional_argument(arguments, "boardId"),
                html,
                optional_argument(arguments, "expectedRevision"),
            )?;
            send_board_change_report(&BoardChangeReport {
                provider: context.provider,
                cli_session_id: context.cli_session_id.clone(),
                runtime_id: context.runtime_id.clone(),
                token: context.token.clone(),
                space_id: context.space_id.clone(),
                board_id: document.id.clone(),
                revision: document.revision.clone(),
            })?;
            serde_json::to_value(document)
                .map_err(|error| BackendError::Platform(error.to_string()))?
        }
        _ => return Err(BackendError::NotFound(format!("MCP tool {name}"))),
    };
    Ok(json!({
        "content": [{"type": "text", "text": value.to_string()}],
        "structuredContent": value
    }))
}

fn required_argument<'a>(arguments: &'a Value, name: &str) -> BackendResult<&'a str> {
    optional_argument(arguments, name)
        .ok_or_else(|| BackendError::Invalid(format!("MCP argument {name} is required")))
}

fn optional_argument<'a>(arguments: &'a Value, name: &str) -> Option<&'a str> {
    arguments.get(name).and_then(Value::as_str)
}

fn required_env(name: &str) -> BackendResult<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BackendError::Invalid(format!("missing {name}")))
}

fn parse_provider(value: &str) -> BackendResult<ProviderKind> {
    match value {
        "claude" => Ok(ProviderKind::Claude),
        "codex" => Ok(ProviderKind::Codex),
        "copilot" => Ok(ProviderKind::Copilot),
        _ => Err(BackendError::Invalid(format!(
            "unsupported Board MCP provider {value}"
        ))),
    }
}

fn write_message(output: &mut impl Write, value: &Value) -> BackendResult<()> {
    serde_json::to_writer(&mut *output, value)
        .map_err(|error| BackendError::Platform(error.to_string()))?;
    output
        .write_all(b"\n")
        .and_then(|_| output.flush())
        .map_err(|error| BackendError::Platform(error.to_string()))
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    fn context() -> BoardMcpContext {
        let root = tempdir().unwrap().keep();
        BoardMcpContext {
            store: LocalBoardStore::open(root).unwrap(),
            provider: ProviderKind::Codex,
            space_id: "space-1".into(),
            cli_session_id: "session-1".into(),
            runtime_id: "runtime-1".into(),
            token: "token".into(),
        }
    }

    #[test]
    fn lists_the_three_board_tools() {
        let response = handle_request(
            &context(),
            &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
        )
        .unwrap();
        assert_eq!(response["result"]["tools"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn lists_and_reads_boards_through_mcp_tools() {
        let context = context();
        context
            .store
            .put(
                &context.space_id,
                Some("architecture"),
                "<html><head><title>Architecture</title></head><body></body></html>",
                None,
            )
            .unwrap();

        let listed = handle_request(
            &context,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "board_list", "arguments": {}}
            }),
        )
        .unwrap();
        assert_eq!(
            listed["result"]["structuredContent"][0]["id"],
            "architecture"
        );

        let read = handle_request(
            &context,
            &json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "board_get", "arguments": {"boardId": "architecture"}}
            }),
        )
        .unwrap();
        assert_eq!(read["result"]["structuredContent"]["title"], "Architecture");
        assert!(
            read["result"]["structuredContent"]["html"]
                .as_str()
                .unwrap()
                .contains("<body>")
        );
    }
}
