# CCSM 设计语言

## 目标

CCSM 延续原版桌面前端的视觉语言：安静、紧凑、内容优先，像一件长期运行的开发工具。界面通过层级、留白和细边框组织信息，避免依赖大色块、厚阴影或装饰性动效。

原版 `public/css/tokens.css`、`base.css`、`sidebar.css`、`layout.css`、`forms.css`、`modal.css` 与 `terminals.css` 是视觉实现参考。v2 在新的 Space、Dockview 和 Tab 模型上复用其 token 与尺寸。

## 视觉原则

### 安静的工具感

- 默认应用外壳使用浅色纸面。
- 功能密度来自紧凑行高与清楚对齐。
- 颜色表达选择、状态和危险操作。
- 常态元素保持低对比，当前上下文获得明确但克制的强调。
- 阴影表达悬浮层级，普通面板主要使用边框分隔。

### 连续的桌面表面

- 侧栏与主区域形成一个连续窗口。
- 40px 顶栏同时承载品牌、当前 Space、全局操作和窗口控制。
- Windows、macOS 与 Linux 使用同一套无边框应用顶栏。
- 可拖动区域覆盖顶栏的空白与标题区域。
- 窗口控制保留各平台可识别的最小化、最大化和关闭语义。

### 一致的明暗模式

- 默认模式使用浅色纸面。
- 顶栏主题按钮在 Light 与 Dark 之间切换并保存选择。
- 应用外壳、Dockview、Terminal、滚动条、菜单和弹窗共享当前模式。
- Terminal 浅色模式使用 VS Code Light+，深色模式使用 VS Code Dark+。
- 主题切换保留 PTY、VT、当前屏幕、scrollback、选择与滚动位置。

## 颜色

### 表面

| Token              | 值        | 用途                         |
| ------------------ | --------- | ---------------------------- |
| `--bg`             | `#f6f8fa` | 主工作区与顶栏               |
| `--bg-elev`        | `#ffffff` | 输入框、菜单、弹窗、内容面板 |
| `--sidebar-bg`     | `#e2ebf3` | 侧栏与目录快捷区域           |
| `--sidebar-hover`  | `#dbe7f0` | hover 行                     |
| `--sidebar-active` | `#d3e1ed` | active 与 selected 行        |

### 文字与规则

| Token             | 值        | 用途                   |
| ----------------- | --------- | ---------------------- |
| `--ink`           | `#1a1815` | 主文字与强图标         |
| `--ink-mid`       | `#534e44` | 次级标签               |
| `--ink-muted`     | `#8a8475` | 路径、时间与辅助状态   |
| `--ink-faint`     | `#b5af9d` | 空闲状态点与占位内容   |
| `--ui-border`     | `#d8d4c6` | 跨区域分隔线           |
| `--border`        | `#d3e1ed` | 控件与面板边框         |
| `--border-strong` | `#c0d5e5` | 输入框与可点击控件边框 |

### 语义色

| Token      | 值        | 语义                         |
| ---------- | --------- | ---------------------------- |
| `--accent` | `#2f6fa3` | 聚焦、主要操作、拖放目标     |
| `--green`  | `#4a8a4a` | ready、running、added        |
| `--yellow` | `#c4892b` | starting、stopping、modified |
| `--red`    | `#b73f3f` | error、deleted、danger       |
| `--blue`   | `#4a73a5` | 当前 Space 与工作状态        |

状态色使用小面积标记。常规状态点直径为 7px，列表状态点在 14px 对齐列中居中。

## 字体

- UI 字体栈：`Geist, Segoe UI, system-ui, sans-serif`。
- 等宽字体栈：`JetBrains Mono, Cascadia Mono, Cascadia Code, Consolas, monospace`。
- File Editor 代码字体栈：`Consolas, Courier New, monospace`，与 Windows 版 VS Code 默认代码字体一致。
- 正文基准为 14px，工具栏与路径使用 10–12px。
- 数值、时间、PID 和路径启用 tabular numerals。
- 标题主要依靠位置和字重形成层级，避免大字号跳变。

## 尺寸与节奏

- 基础间距按 4px 递进。
- 顶栏高度为 40px。
- 展开侧栏默认宽度为232px，可在176–480px之间拖动resize；折叠侧栏宽度为40px。
- 侧栏树行高度为22px，与File Explorer行高一致。
- Dockview 标签带高度为 30px。
- Browser、Files 与 Git 的内容工具栏，以及 Terminal 与 File Editor 的底部状态栏高度统一为 36px。
- 普通圆角为 4px，弹窗最大圆角为 6px。
- 控件内边距优先使用 4、8、12、16px。

同层级元素共享高度和文字基线。树的 chevron、状态点、名称和尾部操作使用固定列对齐。

## 应用外壳

### 顶栏

- 左侧 232px 区域显示 20px CCSM terminal mark 与品牌名。
- 主区域显示当前 Space 名称和单行 root path。
- 主顶栏保留当前Space、主题和窗口控制；New Tab进入Dockview group header。
- 窗口控制按钮占满 40px 顶栏高度。
- 关闭按钮 hover 使用系统可识别的红色表面。
- 侧栏与主工作区从顶栏下沿延伸到窗口底部，全局运行反馈通过可访问状态播报承载。

### 侧栏

- 侧栏以浅蓝灰表面和一条中性右边框建立边界。
- 区域标题使用 12px medium 文本。
- Folder 与 Space 使用同一22px行网格、8px层级indent、12px leaf spacer和16px twistie；Folder使用开合目录图标，Space叶节点只显示名称。
- hover 使用浅蓝表面，active 使用更深一级浅蓝表面。
- 当前Space使用整行selected表面表达，不使用左侧状态点。
- 侧栏右下提供折叠操作；折叠状态仅显示展开按钮。侧栏宽度分隔线以及Spaces/Agents水平分隔线都支持pointer拖动和键盘resize，并持久化尺寸与折叠状态。
- 行内操作在 hover 或键盘聚焦时出现。
- 深色模式保持相同层级关系，并将表面、文字与边框映射到暖黑色 token。

## Tabs 与面板

### Dockview

- Light 的 Tab strip、非活动 Tab、活动 Tab 分别使用 `#f0f0f0`、`#e4e4e4`、`#ffffff`。
- Dark 的 Tab strip、非活动 Tab、活动 Tab 分别使用 `#252526`、`#2d2d2d`、`#1e1e1e`。
- Tab 文本为 12px，最小宽度 88px，最大宽度 200px。
- Tab 图标与关闭按钮分别使用 14px 和 18px 网格；Claude Code、Codex 与 GitHub Copilot 保留品牌色。
- Tab 右键菜单复用原版 CCSM 的 210px 宽度、条目顺序、禁用态和分隔线。
- split sash 保持4px视觉线并提供约16px透明pointer命中区，交互时使用 accent 色提示。
- Tab overflow scrollbar 跟随当前主题。
- 每个Tab group header最右侧显示24px纯加号New Tab操作；空group仍保留header与该操作。

### Terminal

- Terminal 使用原版 VS Code Light+/Dark+ 16 色。
- Terminal Canvas复用原版CCSM xterm字形：`Cascadia Mono, Geist Mono, JetBrains Mono, Consolas, monospace`，桌面字号为`13px`；Windows Cascadia Mono cell geometry为`7×18px`。
- 浅色背景为 `#ffffff`，深色背景为 `#1e1e1e`。
- 工具条和 Terminal scrollbar 跟随当前模式。
- Terminal画布占据上方剩余空间；首字母大写的运行状态、当前CLI Session ID、进程信息和Stop操作在panel最底部保持一行。底部状态行与 Browser toolbar 同为 36px。
- 滚动条贴齐终端 host 的右边界。

### Browser

- Browser toolbar 使用主纸面色与 1px 底边框，由刷新操作和自适应地址栏组成。
- 地址栏使用白色表面、等宽字体和 accent focus ring。
- native WebView 从工具栏下方开始铺满 panel viewport。
- Light/Dark 切换同步设置native WebView preferred color scheme；网页通过`prefers-color-scheme`跟随CCSM主题。
- Modal、New Tab菜单、Tab右键菜单和overflow菜单出现时，Browser viewport保持弹出前一瞬间的静态截图，不闪现空白占位；关闭浮层后恢复live页面。

### Files 与 Git

- Files采用VS Code Explorer风格的22px紧凑行、16px twistie/indent和资源类型图标；Changes文件导航与diff header复用同一套资源图标。
- Changes主体使用内容优先的双栏布局，右侧文件导航默认宽度为220px并以细边框分隔。
- Git repository 与file diff使用轻边框section，header高度为32px；file header在diff滚动区内保持sticky。
- 文件状态通过行尾无边框短代码和语义色表达。
- Diff使用双行号gutter与单字符增删marker。added/deleted背景保持低饱和度，token高亮沿用File Editor配色。
- loading、empty 和 error 状态保持在原布局内，避免大面积占位卡片。

## 菜单与弹窗

- 菜单使用 elevated surface、1px 中性边框、5px 圆角和轻量悬浮阴影。
- 菜单项高度为 28px，hover 复用侧栏 hover 色。
- 模态遮罩使用约 38% 的深色透明层。
- 弹窗头、工具栏、内容和 footer 通过细边框分层。
- 输入、确认和警告统一使用应用内自定义 Modal，不调用浏览器原生 `alert`、`confirm` 或 `prompt`。
- Modal 支持明确的字段标签、危险操作语义、初始焦点、焦点循环、`Escape` 取消和焦点恢复。
- 目录选择器左侧快捷区域复用侧栏表面与选择态。
- 主要操作使用 Ocean blue，普通操作使用当前 elevated surface。

## 动效与反馈

- hover、focus 和背景切换使用 120–140ms 过渡。
- 布局切换和扫描状态不引入持续闪烁。
- reduced-motion 环境停用非必要动画。
- 按钮、输入框和拖放目标始终提供键盘 focus 表现。

## 验收

- 1440×900 下侧栏默认宽度为232px，顶栏实测高度为40px；折叠后侧栏宽度为40px并仅显示展开按钮；resize与折叠状态在本地恢复。
- 应用启动后不显示操作系统原生标题栏。
- 顶栏空白区域可拖动窗口，双击可切换最大化；frameless窗口顶边保留独立的native resize命中区。
- 最小化、最大化和关闭按钮可以通过键盘与指针操作。
- 右上角主题按钮可往返切换 Light/Dark，重启后恢复上次选择。
- Terminal、Dockview Tab strip、Tab overflow scrollbar 与 Terminal scrollbar 同步切换。
- Terminal Canvas的computed font family与原版CCSM保持一致，桌面字号为`13px`；Windows实测cell geometry为`7×18px`。
- 切换主题前后的终端文字、scrollback 长度、滚动位置和输入能力保持一致。
- New Tab菜单、目录选择器和应用Modal出现前先显示Browser截图并隐藏live native surface，关闭后按相反顺序恢复。
- Tab右键菜单和overflow菜单在截图准备期间保持不可见，截图就绪后显示；关闭后恢复live native surface。
- Space tree、Dockview split、终端输入、选择、滚动和 IME 行为保持可用。
- Space可拖入其他Folder或Unfiled；目标行显示accent drop outline，提交后树使用committed workspace snapshot更新。
