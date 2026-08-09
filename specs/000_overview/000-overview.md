# CCSM v2 重构规格

状态：架构方向已锁定，greenfield分阶段实现已开始；首个Space shell、Shell PTY、Dockview和native Browser纵向切片可运行。

目标平台：Windows、macOS、Linux。当前开发和完整验收聚焦 Windows，但核心模型、协议和 Tab API 必须保持平台无关。

## 目标架构

```text
Tauri 2 desktop app
├─ TypeScript UI
│  ├─ Space switcher/store
│  ├─ Dockview layout
│  ├─ Tab platform
│  └─ ghostty-web terminal
└─ Rust host
   ├─ desktop adapter + native child WebViews
   └─ AppBackend
      ├─ PTY/process lifecycle
      ├─ CLI Session + Hook binding
      ├─ Space folder/Git/filesystem services
      └─ SQLite persistence
```

## 已锁定决策

- 前端使用 TypeScript、Vite 和 Dockview，桌面壳使用 Tauri 2。
- Rust 实现本地后端，开发按纵向切片推进。
- OS 能力通过 platform adapters 提供；业务层使用平台中立的 path、命令、IPC 和进程接口。
- Tab、CLI Session 和 PTY runtime 各自拥有独立身份。
- Space 保存一整套 Tab、Dockview layout 和可恢复资源引用。
- Claude/Codex原生Session ID仅接受启动时注入的认证HookReport。
- 终端直接继承现有 ghostty-web stateful 原型，VT 状态由 ghostty-web 持有。
- 浏览器使用 Tauri native child WebView。
- 关闭 Tab 执行视图 detach；停止和删除底层 Session 使用独立命令。
- Rust AppBackend使用单一`data.db`保存durable facts和rebuildable cache；Browser Profile与logs使用filesystem stores。
- Space Switch在应用内保持CLI运行；Space Delete和应用退出统一释放WebViews、PTY、CLI process trees和watchers。
- Desktop通过`CcsmDesktopClient`访问Rust：backend client调用AppBackend，browser client调用ccsm-desktop native host。未来`ccsm-web-server`复用core DTOs和services并提供WebSocket。
- CLI Session持久化`desired_state`；RuntimeManager在内存中维护`actual_state`。当前Space按需自动恢复，未打开Space延迟恢复。
- 桌面首版使用单 Tauri window、单 TypeScript renderer 和单 active Space。
- 所有 Browser Tabs 共享一个全局持久 Browser Profile；未来多账号通过命名 Profile扩展。
- File Explorer 首版提供只读导航、路径操作和从目录启动 CLI；文件 mutation 与编辑器后置。
- Tab平台通过编译期Provider Registry支持新增内置Tab类型；第三方运行时插件体系后置。
- 首版 Space 操作包含 New、Switch、Rename、Move 和 Delete；Duplicate Space 后置。
- 首版 CLI Providers 固定为 Shell、Claude Code 和 Codex；用户自定义 CLI后置。
- 多个Spaces可以共享同一个canonical root和Git cache；AppBackend仅为active Space维护一个`ActiveRootContext`。
- SpaceRoot 创建后不可变；路径缺失时等待原路径恢复，其他目录使用 New Space。
- 一个 CliSession只对应一个 CLI Tab；CLI/Git禁用 Duplicate，Browser/File Explorer按 Provider规则复制。
- Browser cold restore保证 global profile + last URL；WebView navigation/scroll/form runtime state重新开始。
- Terminal VT/scrollback属于当前GUI生命周期；AppBackend通过Tauri Channel转发forward-only PTY bytes。
- 数据存储使用单一`data.db`；durable Schema只做向后兼容的增量演进，`_cache` tables允许清空重建。
- Layout使用自身revision，runtime使用opaque runtime ID，Git scan使用自身generation；普通DTO和domain events不携带通用版本字段。
- 用户mutation由command response更新前端store；`AppEvent`用于runtime、Hook、Git和filesystem变化，`BrowserSurfaceEvent`用于native browser变化。
