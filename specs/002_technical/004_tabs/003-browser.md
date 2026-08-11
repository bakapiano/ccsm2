# Browser Tab

Browser Tab使用Tauri native child WebView，并通过Dockview panel中的DOM anchor同步geometry。Rust surface和profile实现全部位于ccsm-desktop。

## State

```ts
interface BrowserTabState {
  tabId: string;
  lastUrl: string;
  title?: string;
  zoom?: number;
}
```

所有Browser surfaces从ccsm-desktop的`BrowserProfileManager`获取同一个全局持久website data store。

## Desktop host contract

TypeScript Browser Provider通过`BrowserSurfaceClient`执行create、close、setBounds、setVisible、capture、focus、navigate和reload。`ccsm-desktop::browser::BrowserSurfaceManager`持有native handles并实现这些commands。

Navigation、title和load failure通过`BrowserSurfaceEvent`进入统一DesktopEventStream。Provider将`lastUrl/title/zoom`作为普通Tab state提交给`AppBackendClient.tabs`；AppBackend不接收native surface handle、bounds或focus数据。

native child WebView的`on_document_title_changed`发送`surface_id + document title + current URL`。Browser Provider按surface identity更新Dockview Panel title并串行持久化Tab title/state；空白title使用hostname或`Browser`，网页输入最多保留160个Unicode字符。

`window.open`和`target="_blank"`由native WebView的new-window callback拦截。desktop host拒绝系统窗口并发送`source_surface_id + URL`；前端创建持久Browser Tab，并以`direction='within'`加入来源Browser Panel的Dockview group。

## Live lifecycle

- active Tab同步 bounds、visibility和focus。
- inactive Tab隐藏 child WebView并保留 live page runtime。
- navigation/title变更更新Tab state。BrowserSurfaceManager在需要时使用内存navigation ID丢弃已替换surface的迟到callback。
- Delete Tab关闭 surface并保留 global profile。
- inactive Browser重新显示时先提交当前anchor bounds，再调用native show；overflow菜单、Space切换和Dockview重排共享该顺序。
- 应用内Modal或菜单将覆盖Browser panel时，Provider先请求native PNG capture，在DOM anchor中解码并显示静态截图，再隐藏live child WebView；浮层关闭时先恢复live surface，再释放截图data URL。
- 多个重叠浮层共享串行occlusion gate。第一个浮层负责capture/hide，最后一个浮层负责show/release，快速开关不得产生迟到截图或反向visibility。
- capture失败或超时时仍隐藏native surface并显示中性占位，保证外部页面不会覆盖可信应用UI。

## Theme

主WebView在bootstrap之前把已保存的Light/Dark模式提交给Tauri window，并在每次切换时继续同步。child WebView创建时读取window theme；存量surface接收Wry theme change。Windows由WebView2 profile `SetPreferredColorScheme`更新`prefers-color-scheme`，支持该media query的网站随CCSM切换。

## Cold restore

GUI重启后 Tauri host重新创建 child WebView，并使用 global profile加载 `lastUrl`。cookies、登录、localStorage、IndexedDB和HTTP cache由profile恢复。

navigation history、scroll position、form/input和页面内存状态属于旧 WebView runtime；cold restore创建新的页面运行实例。

## Capability

外部页面使用空的Tauri capability集合。地址栏、navigation、reload、focus和close命令由可信主WebView通过`BrowserSurfaceClient`调用ccsm-desktop。

Surface创建失败时保留TabRecord并显示failed/Retry。Delete先请求close surface，再删除TabRecord；遗留surface由ccsm-desktop shutdown统一回收。

Windows adapter使用WebView2 `CapturePreview(PNG)`。macOS WKWebView与Linux WebKitGTK snapshot adapter按跨平台能力矩阵接入；共享TypeScript contract与occlusion时序保持一致。
