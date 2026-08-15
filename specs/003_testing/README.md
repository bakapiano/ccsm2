# 测试规格

CCSM 桌面测试统一采用 WebdriverIO、`@wdio/tauri-service` 和 embedded WebDriver，并提供两个入口：

- [GitHub Actions 测试门禁](000-automated.md)：Windows 与 Linux 分别构建、测试并生成 GIF 验收证据。
- [本地 Desktop E2E 调试](001-development.md)：开发者在本机运行同一套测试、定位失败并重放单个场景。

自动断言决定平台 job 的成功或失败；GIF、截图、结构化结果和日志提供人工验收证据。PR 合并同时要求 Windows/Linux 必需检查通过以及 reviewer 完成人工验收。
