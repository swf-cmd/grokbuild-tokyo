# Screenshot notes · 截图说明

These screenshots show the real Grokbuild Tokyo Electron interface on Windows at 1440 × 940 pixels. Mac uses the same interface content with native window controls and Command-key shortcuts. They were captured with Playwright using the repository's isolated `tests/fixtures/ui-app.cjs` test entry point. The main process, IPC bridge, renderer, and bundled Tokyo artwork are the production application; the CLI adapter is an offline test fixture.

The focus-timer conversation is authored demo content, not a recorded model response. The visible `UI-TEST` engine label and model selection are fixture data and do not promise access to any particular model. No personal conversations, login credentials, or paid model requests were used. `R:\Workspace` is a temporary alias to the isolated screenshot workspace.

这些图片是 Windows 上 Grokbuild Tokyo 真实 Electron 界面的 1440 × 940 像素截图；Mac 共用相同界面内容，使用原生窗口按钮和 Command 快捷键。截图通过 Playwright 和仓库中的隔离测试入口 `tests/fixtures/ui-app.cjs` 拍摄。主进程、IPC、界面及东京背景均来自实际应用，CLI 适配器使用离线模拟引擎。

专注计时器对话是为展示编写的示例内容，并非真实模型回复。界面中的 `UI-TEST` 引擎标记与模型选项属于测试数据，不代表特定模型的可用性。截图未使用个人聊天、登录凭据或付费模型请求。`R:\Workspace` 是隔离截图工作目录的临时路径别名。

| File / 文件 | View / 界面 |
| --- | --- |
| `welcome-en.png` | English welcome screen / 英文欢迎页 |
| `app-en.png` | English demo conversation / 英文示例对话 |
| `welcome-zh-CN.png` | Simplified Chinese welcome screen / 简体中文欢迎页 |
| `app-zh-CN.png` | Simplified Chinese demo conversation / 简体中文示例对话 |

Captured on 2026-09-08. Rain is explicitly enabled. The two production rain animations are paused at a fixed point in their cycles for each PNG, preserving the droplets instead of removing animations during capture. The app naturally makes rain subtler in conversations. These are static frames of the live rain effect; no rain was painted onto the images and no production styles were changed for the screenshots.

拍摄于 2026-09-08，明确开启了雨滴。截图时将应用原有的两层雨滴动画暂停在固定帧，保留雨滴，不通过禁用动画来拍摄。聊天界面中的雨滴按应用原本设计更淡。PNG 展示动态雨滴的一帧，未在图片上后期添加雨滴，也未为截图修改应用样式。

## Reproduce / 重新拍摄

On Windows, install dependencies with `npm ci`, then run `node scripts/capture-readme.cjs`. Alternatively, run the **README screenshots** workflow in GitHub Actions and download its `readme-screenshots` artifact.

The four candidate images are written to `work/readme-capture/images/`. The `qa/` directory contains matching rain-on/rain-off captures and `results.json`, which verifies that the rain changes rendered pixels. Review the images before copying them to `docs/images/`. The capture uses a fixed demo clock and isolated fixture data, with music muted and no real CLI requests.

Windows 上先运行 `npm ci`，再运行 `node scripts/capture-readme.cjs`。也可在 GitHub Actions 手动运行 **README screenshots** 工作流，下载 `readme-screenshots` 产物。

四张候选图片保存在 `work/readme-capture/images/`；`qa/` 中保留相同画面的雨滴开启/关闭对照图及 `results.json`，检查雨滴是否实际改变了画面像素。确认图片后再复制到 `docs/images/`。拍摄使用固定演示时间与隔离测试数据，音乐静音，不调用真实 CLI。
