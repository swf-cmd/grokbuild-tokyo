# Third-party notices and asset credits

## Project license

Grokbuild Tokyo's original code and documentation are available under the [MIT License](LICENSE), copyright 2026 swf-cmd and contributors. The project-maintained icon, synthesized music, generated background and documentation screenshots are made available under the same license to the extent the contributors hold applicable rights. Third-party software and third-party names, signs or marks remain subject to their respective rights; the MIT license does not grant trademark rights.

Grokbuild Tokyo is an independent, unofficial client. It is not affiliated with or endorsed by xAI. Grok and xAI names identify the service and CLI this client connects to. The official Grok Build CLI is installed separately and is not bundled in this repository or the desktop build; its own license and service terms apply independently.

## Bundled browser libraries

These browser distributions are included unmodified. Their original notices remain in the JavaScript files, and the accompanying license texts are distributed with the application.

| Component | Version | File | License / notice |
| --- | --- | --- | --- |
| [Marked](https://github.com/markedjs/marked) | 18.0.11 | `src/renderer/vendor/marked.umd.js` | MIT; the bundled notice also contains the Markdown BSD-style notice. [Full text](licenses/marked-LICENSE.txt). |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.15 | `src/renderer/vendor/purify.min.js` | Apache-2.0 OR MPL-2.0. [Full texts](licenses/DOMPurify-LICENSE.txt). |

## Electron and development dependencies

On Windows, Electron and its bundled Chromium components retain their `LICENSE` and `LICENSES.chromium.html` files in the generated `App` directory. On Mac, they are included inside `Grokbuild Tokyo.app/Contents/Resources` as `LICENSE.electron.txt` and `LICENSES.chromium.html`, so the `.app` and its ZIP retain these notices. Keep these files when distributing a build. The project's own `LICENSE`, this notice and the browser-library license texts are included in `App/resources/app.asar` on Windows, or `Grokbuild Tokyo.app/Contents/Resources/app.asar` on Mac.

Other development dependencies and their exact versions are recorded in `package-lock.json`. Their notices are available in their installed packages. The project's MIT license does not replace any dependency license.

## Artwork, audio and screenshots

| Asset | Origin |
| --- | --- |
| `src/renderer/assets/tokyo-rain.png` | AI-generated Shibuya rainy-night scene. Generation prompt: [IMAGE-PROMPT.md](src/renderer/assets/IMAGE-PROMPT.md). It is an illustration, not a documentary photograph. |
| `src/renderer/assets/icon.png`, `icon.ico`, `icon.icns` | Project icon drawn by [scripts/make-icon.py](scripts/make-icon.py); the Mac icon is converted from that PNG by [scripts/make-mac-icon.cjs](scripts/make-mac-icon.cjs). |
| `src/renderer/assets/tokyo-afterimage.wav` | **Tokyo Afterimage · 東京残像**, an original, locally synthesized instrumental: 80 BPM, 96-second loop. Composition and synthesis: [scripts/ambient-score.js](scripts/ambient-score.js); render with `node scripts/render-ambience.cjs`. No third-party recordings or samples are used. |
| `docs/images/*.png` | Captures of the project's real Electron interface using isolated demo data and a simulated engine. Demo text is illustrative, not an actual model response or performance claim. |

## 中文说明

本项目原创代码、文档，以及维护者有权授权的图标、合成器音乐、生成背景和文档截图，采用根目录的 [MIT 许可证](LICENSE)。第三方组件保留各自的许可证；第三方名称、标识或商标不因本许可证而获得授权。

本项目为独立、非官方客户端，与 xAI 无隶属关系，也未获其背书。Grok Build CLI 需单独安装，不随本仓库或桌面构建分发，其许可证和服务条款独立适用。

Marked 与 DOMPurify 的原始声明和许可文本随程序保留。Windows 的 Electron 许可文件为 `App` 中的 `LICENSE` 与 `LICENSES.chromium.html`；Mac 则将它们以 `LICENSE.electron.txt` 和 `LICENSES.chromium.html` 保存在 `Grokbuild Tokyo.app/Contents/Resources` 内，单独分发 `.app` 或 ZIP 时也会保留。本项目的许可证、本文及浏览器库许可文本位于 Windows 的 `App/resources/app.asar` 或 Mac 的 `Grokbuild Tokyo.app/Contents/Resources/app.asar` 内。

涩谷背景为 AI 生成图，并非实景纪实照片；图标由脚本绘制；《Tokyo Afterimage · 東京残像》为无第三方录音采样的原创合成器器乐。文档截图采用隔离演示数据和模拟引擎，不展示真实账户信息或真实模型回复。
