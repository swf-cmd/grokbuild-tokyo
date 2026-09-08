# Screenshot notes · 截图说明

These screenshots show the real Grokbuild Tokyo Electron interface on Windows at 1440 × 940 pixels. Mac uses the same interface content with native window controls and Command-key shortcuts. They were captured with Playwright using the repository's isolated `tests/fixtures/ui-app.cjs` test entry point. The main process, IPC bridge, renderer, and bundled Tokyo artwork are the production application; the CLI adapter is an offline test fixture.

The focus-timer conversation is authored demo content, not a recorded model response. The visible `UI-TEST` engine label and model selection are fixture data and do not promise access to any particular model. No personal conversations, login credentials, or paid model requests were used. `R:\Workspace` is a temporary alias to the isolated screenshot workspace.

这些图片是 Windows 上 Grokbuild Tokyo 真实 Electron 界面的 1440 × 940 像素截图；Mac 共用相同界面内容，使用原生窗口按钮和 Command 快捷键。截图通过 Playwright 和仓库中的隔离测试入口 `tests/fixtures/ui-app.cjs` 拍摄。主进程、IPC、界面及东京背景均来自实际应用，CLI 适配器使用离线模拟引擎。

专注计时器对话是为展示编写的示例内容，并非真实模型回复。界面中的 `UI-TEST` 引擎标记与模型选项属于测试数据，不代表特定模型的可用性。截图未使用个人聊天、登录凭据或付费模型请求。`R:\Workspace` 是隔离截图工作目录的临时路径别名。

| File / 文件 | View / 界面 |
| --- | --- |
| `welcome-en.png` | English welcome screen / 英文欢迎页 |
| `welcome-en.gif` | English welcome screen with animated rain / 英文欢迎页雨滴动图 |
| `app-en.png` | English demo conversation / 英文示例对话 |
| `welcome-zh-CN.png` | Simplified Chinese welcome screen / 简体中文欢迎页 |
| `welcome-zh-CN.gif` | Simplified Chinese welcome screen with animated rain / 简体中文欢迎页雨滴动图 |
| `app-zh-CN.png` | Simplified Chinese demo conversation / 简体中文示例对话 |

Captured on 2026-09-08 with rain enabled. The README uses looping welcome-screen GIFs so the rain remains recognizable when the image is scaled down. Each GIF records three seconds of the two production rain animations at 20 frames per second. The PNGs retain a fixed frame of the same effect; rain is naturally subtler in conversations. No rain was painted onto the images and no production styles were changed for the captures.

拍摄于 2026-09-08，开启了雨滴。介绍页使用循环播放的欢迎页 GIF，让缩小后的图片也能通过运动呈现下雨效果。每张 GIF 以每秒 20 帧记录应用原有的两层雨滴动画，共三秒。PNG 保留同一效果的固定帧，聊天界面中的雨滴按应用原本设计更淡。未在图片上后期添加雨滴，也未为拍摄修改应用样式。

## Reproduce / 重新拍摄

On Windows, install dependencies with `npm ci`, then run `node scripts/capture-readme.cjs` for the PNGs. To also create the GIFs, install FFmpeg on `PATH` and run `node scripts/capture-readme.cjs --motion`. Alternatively, run the **README screenshots** workflow in GitHub Actions, which includes GIF capture, and download its `readme-screenshots` artifact.

Candidate images are written to `work/readme-capture/images/`. The `qa/` directory contains matching rain-on/rain-off captures and `results.json`, which checks rain rendering, motion, and an otherwise stable interface. Review the GIFs playing at README display size before copying them to `docs/images/`; pixel differences alone do not establish that rain is easy to see. The capture uses a fixed demo clock and isolated fixture data, with music muted and no real CLI requests.

Windows 上先运行 `npm ci`，再运行 `node scripts/capture-readme.cjs` 生成 PNG。如需同时生成 GIF，将 FFmpeg 加入 `PATH` 后运行 `node scripts/capture-readme.cjs --motion`。也可在 GitHub Actions 手动运行包含动图拍摄的 **README screenshots** 工作流，下载 `readme-screenshots` 产物。

候选图片保存在 `work/readme-capture/images/`；`qa/` 中保留相同画面的雨滴开启/关闭对照图及 `results.json`，检查雨滴渲染、运动和其余界面的稳定性。复制到 `docs/images/` 前，应按介绍页实际显示尺寸检查 GIF 的播放效果；仅有像素变化不能证明雨滴容易辨认。拍摄使用固定演示时间与隔离测试数据，音乐静音，不调用真实 CLI。
