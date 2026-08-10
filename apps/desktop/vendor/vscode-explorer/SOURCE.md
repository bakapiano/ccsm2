# VS Code Explorer reference

CCSM's File Explorer tree interaction and visual structure are adapted from the
Microsoft VS Code Explorer and base tree/list implementation at commit
`4bef75520b2f8d1d76a1e44962dbada7a7b34a7b`.

Reference paths:

- `src/vs/workbench/contrib/files/browser/views/explorerView.ts`
- `src/vs/workbench/contrib/files/browser/views/explorerViewer.ts`
- `src/vs/workbench/contrib/files/browser/media/explorerviewlet.css`
- `src/vs/base/browser/ui/tree/abstractTree.ts`
- `src/vs/base/browser/ui/tree/media/tree.css`
- `src/vs/base/browser/ui/list/list.css`

The production implementation is adapted to CCSM's existing DOM renderer,
filesystem DTOs, watcher, and persisted Tab state. It does not import or load
the external VS Code checkout at runtime or build time.

See [LICENSE.txt](LICENSE.txt) for the upstream MIT license.
