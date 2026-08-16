import { readFileSync, writeFileSync } from "node:fs";

export type Provider = "claude" | "codex" | "copilot";

interface ModelMockConfig {
  defaultResponse: string;
  providers: Partial<Record<Provider, Record<string, string>>>;
}

export interface ModelMockEvent {
  timestampMs: number;
  event: "session-start" | "model-response";
  provider: Provider;
  cliSessionId: string;
  nativeSessionId: string;
  resumed: boolean;
  prompt?: string;
  response?: string;
  arguments?: string[];
}

function requiredPath(name: string): string {
  const path = process.env[name];
  if (!path) throw new Error(`${name} is required`);
  return path;
}

export function setModelResponse(
  provider: Provider,
  prompt: string,
  response: string,
): void {
  const path = requiredPath("CCSM_E2E_MODEL_MOCK_FILE");
  const config = JSON.parse(readFileSync(path, "utf8")) as ModelMockConfig;
  config.providers[provider] ??= {};
  config.providers[provider]![prompt] = response;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function readModelMockEvents(provider: Provider): ModelMockEvent[] {
  const path = requiredPath("CCSM_E2E_MODEL_MOCK_LOG");
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ModelMockEvent)
      .filter((event) => event.provider === provider);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
