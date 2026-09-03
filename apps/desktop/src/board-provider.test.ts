import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { AppEvent } from "./generated/AppEvent";
import type { BoardDocumentDto } from "./generated/BoardDocumentDto";
import type { TabDto } from "./generated/TabDto";
import { BoardTabProvider } from "./tabs/board-provider";
import type { CcsmDesktopClient } from "./transport/desktop-client";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => document.body.replaceChildren());
afterAll(() => GlobalRegistrator.unregister());

describe("Board Tab provider", () => {
  test("loads sandboxed HTML and refreshes after board.changed", async () => {
    let documentValue = boardDocument("First", "revision-1");
    let listener: ((event: AppEvent) => void) | null = null;
    const readBoard = mock(async () => ({ ...documentValue }));
    const client = {
      backend: { readBoard },
      events: {
        subscribe: async (next: (event: AppEvent) => void) => {
          listener = next;
          return () => {};
        },
      },
    } as unknown as CcsmDesktopClient;
    const provider = new BoardTabProvider(client);
    const renderer = provider.createRenderer(boardTab());

    renderer.init({ api: {} } as never);
    await waitFor(() => renderer.element.dataset.status === "ready");

    const frame =
      renderer.element.querySelector<HTMLIFrameElement>(".board-frame")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.srcdoc).toContain("<title>First</title>");

    documentValue = boardDocument("Second", "revision-2");
    listener!({
      kind: "board.changed",
      payload: {
        sourceCliSessionId: "session-1",
        tab: { ...boardTab(), title: "Second" },
        board: {
          id: "architecture",
          spaceId: "space-1",
          title: "Second",
          revision: "revision-2",
        },
      },
    });
    await waitFor(() => frame.srcdoc.includes("<title>Second</title>"));

    expect(readBoard).toHaveBeenCalledTimes(2);
    expect(renderer.element.textContent).toContain("Second");
    renderer.dispose?.();
    provider.destroy();
  });
});

function boardDocument(title: string, revision: string): BoardDocumentDto {
  return {
    id: "architecture",
    spaceId: "space-1",
    title,
    revision,
    html: `<!doctype html><html><head><title>${title}</title></head><body><button>Run</button><script>document.body.dataset.ready = "true";</script></body></html>`,
  };
}

function boardTab(): TabDto {
  return {
    id: "board-tab",
    spaceId: "space-1",
    kind: "board",
    title: "First",
    resourceId: "architecture",
    stateVersion: 1,
    state: { boardId: "architecture", revision: "revision-1" },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}
