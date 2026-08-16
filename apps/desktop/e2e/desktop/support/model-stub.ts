import { readFileSync, writeFileSync } from "node:fs";

export type Provider = "claude" | "codex" | "copilot";

interface ModelStubConfig {
  defaultResponse?: string;
  providers: Partial<Record<Provider, Record<string, string>>>;
}

export interface ModelStubEvent {
  at: string;
  method: string;
  path: string;
  provider: Provider;
  model?: string;
  prompt: string;
  response: string;
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
  const path = requiredPath("CCSM_E2E_MODEL_STUB_FILE");
  const config = JSON.parse(readFileSync(path, "utf8")) as ModelStubConfig;
  config.providers[provider] ??= {};
  config.providers[provider]![prompt] = response;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function readModelStubEvents(provider: Provider): ModelStubEvent[] {
  const path = requiredPath("CCSM_E2E_MODEL_STUB_LOG");
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ModelStubEvent)
      .filter((event) => event.provider === provider);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
