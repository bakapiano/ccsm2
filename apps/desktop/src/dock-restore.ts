import type { SerializedDockview } from "dockview";

export function deferredDockviewSnapshot(
  snapshot: SerializedDockview,
): SerializedDockview {
  return {
    ...snapshot,
    panels: Object.fromEntries(
      Object.entries(snapshot.panels).map(([id, panel]) => [
        id,
        { ...panel, renderer: "onlyWhenVisible" as const },
      ]),
    ),
  };
}
