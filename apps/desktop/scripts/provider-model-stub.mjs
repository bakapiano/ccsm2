import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const logPath = process.env.CCSM_PROVIDER_MODEL_STUB_LOG;
if (!logPath) throw new Error("CCSM_PROVIDER_MODEL_STUB_LOG is required");
const expectedApiKey = process.env.CCSM_PROVIDER_MODEL_STUB_KEY;
if (!expectedApiKey)
  throw new Error("CCSM_PROVIDER_MODEL_STUB_KEY is required");
let responseSequence = 0;

const server = createServer(async (request, response) => {
  try {
    const body = await readBody(request);
    const payload = body ? JSON.parse(body) : {};
    const provider = providerFromRequest(request.url);
    const modelRequest =
      request.method === "POST" &&
      (request.url?.includes("/messages") ||
        request.url?.includes("/responses"));
    if (modelRequest) assertSyntheticAuthentication(request);
    const promptCandidates = extractPrompts(payload)
      .map((prompt) => normalizePrompt(provider, prompt))
      .filter(Boolean);
    const { prompt, response: modelResponse } = responseSelection(
      provider,
      promptCandidates,
    );
    const context = configuredContextMarkers(provider, payload);
    const sequence = ++responseSequence;
    const responseId =
      provider === "claude"
        ? `msg_ccsm_provider_stub_${sequence}`
        : `resp_ccsm_provider_stub_${sequence}`;
    appendEvent({
      method: request.method,
      path: request.url,
      provider,
      model: payload.model,
      prompt,
      response: modelResponse,
      responseId,
      previousResponseId: payload.previous_response_id ?? null,
      configuredPromptsPresent: context.prompts,
      configuredResponsesPresent: context.responses,
      syntheticAuthentication: modelRequest,
    });

    if (request.method === "POST" && request.url?.includes("/messages")) {
      sendAnthropicResponse(response, payload, modelResponse, responseId);
      return;
    }
    if (request.method === "POST" && request.url?.includes("/responses")) {
      sendOpenAiResponse(
        response,
        payload,
        modelResponse,
        responseId,
        sequence,
      );
      return;
    }
    if (request.method === "GET" && request.url?.includes("/models")) {
      sendJson(response, 200, { object: "list", data: [] });
      return;
    }
    sendJson(response, 404, {
      error: { message: "CCSM provider model stub route not found" },
    });
  } catch (error) {
    appendEvent({
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(response, 500, {
      error: { message: "CCSM provider model stub failed" },
    });
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("provider model stub did not bind a TCP port");
  }
  process.stdout.write(`CCSM_PROVIDER_MODEL_STUB_READY ${address.port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function sendAnthropicResponse(response, payload, text, responseId) {
  const message = {
    id: responseId,
    type: "message",
    role: "assistant",
    model: payload.model ?? "claude-sonnet-4-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1,
    },
  };
  if (!payload.stream) {
    sendJson(response, 200, message);
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  sendEvent(response, "message_start", {
    type: "message_start",
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  sendEvent(response, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  sendEvent(response, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
  sendEvent(response, "content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });
  sendEvent(response, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  sendEvent(response, "message_stop", { type: "message_stop" });
  response.end();
}

function sendOpenAiResponse(response, payload, text, responseId, sequence) {
  const createdAt = Math.floor(Date.now() / 1000);
  const output = {
    id: `msg_ccsm_provider_stub_${sequence}`,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", annotations: [], logprobs: [], text }],
  };
  const completed = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "completed",
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: payload.model ?? "gpt-5.3-codex",
    output: [output],
    parallel_tool_calls: true,
    previous_response_id: payload.previous_response_id ?? null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: "text" }, verbosity: "medium" },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
    user: null,
    metadata: {},
  };
  if (!payload.stream) {
    sendJson(response, 200, completed);
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let eventSequence = 0;
  const emit = (type, event) =>
    sendEvent(response, type, {
      type,
      sequence_number: eventSequence++,
      ...event,
    });
  emit("response.created", {
    response: { ...completed, status: "in_progress", output: [], usage: null },
  });
  emit("response.in_progress", {
    response: { ...completed, status: "in_progress", output: [], usage: null },
  });
  emit("response.output_item.added", {
    output_index: 0,
    item: { ...output, content: [] },
  });
  emit("response.content_part.added", {
    item_id: output.id,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", annotations: [], logprobs: [], text: "" },
  });
  emit("response.output_text.delta", {
    item_id: output.id,
    output_index: 0,
    content_index: 0,
    delta: text,
    logprobs: [],
  });
  emit("response.output_text.done", {
    item_id: output.id,
    output_index: 0,
    content_index: 0,
    text,
    logprobs: [],
  });
  emit("response.content_part.done", {
    item_id: output.id,
    output_index: 0,
    content_index: 0,
    part: output.content[0],
  });
  emit("response.output_item.done", { output_index: 0, item: output });
  emit("response.completed", { response: completed });
  response.write("data: [DONE]\n\n");
  response.end();
}

function responseSelection(provider, promptCandidates) {
  const fallbackPrompt =
    promptCandidates.at(-1) ?? "CCSM_PROVIDER_CONTRACT_PROMPT";
  const configPath = process.env.CCSM_PROVIDER_MODEL_STUB_CONFIG;
  if (configPath) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const responses = config.providers?.[provider] ?? {};
    const configured = configuredResponse(promptCandidates, responses);
    if (configured) return configured;
    if (typeof config.defaultResponse === "string")
      return { prompt: fallbackPrompt, response: config.defaultResponse };
    throw new Error(
      `no model response configured for provider=${provider} prompt=${fallbackPrompt}`,
    );
  }
  if (provider === "claude")
    return {
      prompt: fallbackPrompt,
      response: `CCSM_CLAUDE_REAL_CLI_RESPONSE:${fallbackPrompt}`,
    };
  if (provider === "copilot")
    return {
      prompt: fallbackPrompt,
      response: `CCSM_COPILOT_REAL_CLI_RESPONSE:${fallbackPrompt}`,
    };
  return {
    prompt: fallbackPrompt,
    response: `CCSM_CODEX_REAL_CLI_RESPONSE:${fallbackPrompt}`,
  };
}

function configuredResponse(promptCandidates, responses) {
  const entries = Object.entries(responses);
  for (let index = promptCandidates.length - 1; index >= 0; index -= 1) {
    const prompt = promptCandidates[index];
    if (typeof responses[prompt] === "string") {
      return { prompt, response: responses[prompt] };
    }
    const match = entries
      .map(([candidate, response]) => ({
        candidate,
        response,
        index: prompt.lastIndexOf(candidate),
      }))
      .filter((candidate) => candidate.index >= 0)
      .sort((left, right) => right.index - left.index)[0];
    if (match) return { prompt: match.candidate, response: match.response };
  }
  return undefined;
}

function configuredContextMarkers(provider, payload) {
  const configPath = process.env.CCSM_PROVIDER_MODEL_STUB_CONFIG;
  if (!configPath) return { prompts: [], responses: [] };
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const configured = config.providers?.[provider] ?? {};
  const payloadText = JSON.stringify(payload);
  return {
    prompts: Object.keys(configured).filter((value) =>
      payloadText.includes(value),
    ),
    responses: Object.values(configured).filter(
      (value) => typeof value === "string" && payloadText.includes(value),
    ),
  };
}

function assertSyntheticAuthentication(request) {
  const apiKey = request.headers["x-api-key"];
  const authorization = request.headers.authorization;
  const bearer = `Bearer ${expectedApiKey}`;
  if (apiKey === expectedApiKey || authorization === bearer) return;
  throw new Error("provider model request did not use the synthetic API key");
}

function providerFromRequest(url = "") {
  if (url.includes("/copilot/")) return "copilot";
  if (url.includes("/messages")) return "claude";
  return "codex";
}

function normalizePrompt(provider, prompt) {
  if (provider !== "copilot") return prompt;
  return prompt
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gu, "")
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/gu, "")
    .trim();
}

function extractPrompts(payload) {
  const values = [];
  collectStrings(payload.messages, values);
  collectStrings(payload.input, values);
  return values.length > 0 ? values : ["CCSM_PROVIDER_CONTRACT_PROMPT"];
}

function collectStrings(value, output) {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (["text", "content", "input_text"].includes(key))
        collectStrings(item, output);
    }
  }
}

function sendEvent(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value)}\n`);
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () =>
      resolveBody(Buffer.concat(chunks).toString("utf8")),
    );
  });
}

function appendEvent(event) {
  appendFileSync(
    logPath,
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
  );
}
