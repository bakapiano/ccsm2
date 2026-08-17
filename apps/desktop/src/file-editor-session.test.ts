import { ChangeSet } from "@codemirror/state";
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { FileDocumentDto } from "./generated/FileDocumentDto";
import type { TabDto } from "./generated/TabDto";
import type { CcsmDesktopClient } from "./transport/desktop-client";

GlobalRegistrator.register();
const { FileEditorSession } = await import("./tabs/file-editor-provider");
afterAll(() => GlobalRegistrator.unregister());

describe("File Editor session mount lifecycle", () => {
  test("reloads a clean document changed while detached", async () => {
    const harness = sessionHarness(document("base", "revision-1"));
    harness.session.attach();
    await waitFor(() => harness.session.snapshot().status === "clean");

    harness.session.detach();
    harness.setDocument(document("from disk", "revision-2"));
    harness.session.attach();
    await waitFor(
      () =>
        harness.readCount() === 2 &&
        harness.session.snapshot().content === "from disk",
    );

    expect(harness.session.snapshot().status).toBe("clean");
    harness.session.dispose();
  });

  test("reports a conflict when a dirty document changed while detached", async () => {
    const harness = sessionHarness(document("base", "revision-1"));
    harness.session.attach();
    await waitFor(() => harness.session.snapshot().status === "clean");
    harness.session.applyEditorChanges(
      ChangeSet.of([{ from: 4, insert: " local" }], 4),
      () => "base local",
    );

    harness.session.detach();
    harness.setDocument(document("from disk", "revision-2"));
    harness.session.attach();
    await waitFor(() => harness.session.snapshot().status === "conflict");

    expect(harness.readCount()).toBe(2);
    expect(harness.session.snapshot().content).toBe("base");
    expect(harness.session.isDirty()).toBe(true);
    harness.session.dispose();
  });
});

function sessionHarness(initialDocument: FileDocumentDto): {
  session: InstanceType<typeof FileEditorSession>;
  readCount(): number;
  setDocument(document: FileDocumentDto): void;
} {
  let currentDocument = initialDocument;
  let reads = 0;
  const client = {
    backend: {
      readFile: async () => {
        reads += 1;
        return { ...currentDocument };
      },
    },
    events: {
      subscribe: async () => () => {},
    },
  } as unknown as CcsmDesktopClient;
  const session = new FileEditorSession(
    tab(),
    client,
    () => {},
    async <T extends string>() => "cancel" as T,
  );
  return {
    session,
    readCount: () => reads,
    setDocument: (value) => {
      currentDocument = value;
    },
  };
}

function document(content: string, revision: string): FileDocumentDto {
  return {
    spaceId: "space",
    relativePath: "README.md",
    content,
    status: "editable",
    reason: null,
    size: content.length,
    revision,
    utf8Bom: false,
    lineEnding: "lf",
    syntaxHighlighting: true,
  };
}

function tab(): TabDto {
  return {
    id: "tab",
    spaceId: "space",
    kind: "file-editor",
    title: "README.md",
    resourceId: "README.md",
    stateVersion: 1,
    state: {},
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition did not become true");
}
