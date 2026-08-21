# 总体架构

## 进程与crate边界

```text
ccsm.exe
├─ TypeScript renderer
│  ├─ Space/Tab/Dockview
│  └─ ghostty-web VT
└─ Tauri Rust host
   ├─ ccsm-desktop adapter
   ├─ ccsm-core AppBackend
   ├─ ccsm-platform adapters
   └─ native child WebViews
```

桌面首版创建一个Tauri进程、一个window和一个TypeScript renderer，并在其中切换active Space。release构建的第二次启动通过single-instance routing聚焦已有窗口；debug构建可与已安装release实例并行运行。

`ccsm-desktop`依赖`ccsm-core + ccsm-platform`。`ccsm-core`的dependency graph保持Tauri-free。未来`ccsm-web-server`复用相同core/platform crates。

## 所有权

| 对象                                                       | 唯一所有者                         |
| ---------------------------------------------------------- | ---------------------------------- |
| Tab、窗口和 Dockview 布局                                  | TypeScript UI                      |
| 终端 VT、viewport、selection、scrollback                   | ghostty-web                        |
| PTY、CLI 进程、resize、进程树清理                          | Rust AppBackend/Platform           |
| CLI Session、native ID、runtime registry和resume mutex     | Rust AppBackend                    |
| native child WebView 生命周期与 bounds                     | Tauri host                         |
| 全局 Browser Profile 和平台 website data store             | Tauri host `BrowserProfileManager` |
| Space、Folder、Tab records                                 | Rust AppBackend                    |
| SQLite、active SpaceRoot filesystem/Git services和文件导航 | Rust Platform adapters             |

浏览器引擎由平台提供：Windows使用WebView2，macOS使用WKWebView，Linux使用WebKitGTK。引擎私有API和conditional compilation统一收口在`ccsm-desktop::browser::BrowserSurfaceManager`。

## 边界原则

- Dockview 管理布局和 panel DOM。
- 对应 Tab provider 和 runtime 管理业务资源生命周期。
- Rust 传输有序 PTY bytes；ghostty-web 解析 ANSI 并持有 VT 状态。
- 外部网页运行在空的Tauri capability集合中；可信主renderer调用desktop adapter。
- TypeScript应用层通过`CcsmDesktopClient`访问Rust；desktop transport adapter集中映射Tauri commands/events和binary Channel。
- ccsm-core DTO和service ports保持transport-independent，供未来WebSocket adapter复用。
- PTY、IPC、进程树、CLI shim、路径和文件监听通过ccsm-platform接入领域层。
- Native child WebView和Browser Profile由ccsm-desktop管理，并通过`BrowserSurfaceClient/BrowserSurfaceEvent`连接TypeScript Browser Provider。

## 首版范围

- v2 使用Tauri内置前端和同进程Rust AppBackend。
- v2 使用 Space 作为完整布局的保存和恢复边界。
- 编译期TabProvider Registry是新增内置Tab类型的源码扩展点。
- 第三方runtime loader、permission contract和sandbox归入未来插件产品。
- 应用进程异常退出后的恢复方式是重新创建PTY并执行受控native resume。
