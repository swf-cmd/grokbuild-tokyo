<div align="center">

<img src="src/renderer/assets/icon.png" alt="Grokbuild Tokyo 图标" width="88" />

# Grokbuild Tokyo · 东京雨夜

**城市未眠，你的灵感也是。**

为 [Grok Build](https://x.ai/cli) 编程智能体打造的桌面应用：流式对话、多任务并行、多账户独立管理，窗外是东京的雨夜。

[English](README.md) · **简体中文**

[![测试](https://github.com/swf-cmd/grokbuild-tokyo/actions/workflows/test.yml/badge.svg)](https://github.com/swf-cmd/grokbuild-tokyo/actions/workflows/test.yml)
[![最新版本](https://img.shields.io/github/v/release/swf-cmd/grokbuild-tokyo?label=release&color=c1adff)](https://github.com/swf-cmd/grokbuild-tokyo/releases/latest)
[![MIT 许可证](https://img.shields.io/badge/license-MIT-71d6c6)](LICENSE)
![Windows x64](https://img.shields.io/badge/platform-Windows_x64-86b7f9)
![macOS 13+ · Intel + Apple Silicon](https://img.shields.io/badge/macOS-13%2B_Intel_%2B_Apple_Silicon-86b7f9)

**[下载 Mac 版](https://github.com/swf-cmd/grokbuild-tokyo/releases/download/v1.2.4/Grokbuild-Tokyo-1.2.4-mac-universal.zip) · [下载 Windows 版](https://github.com/swf-cmd/grokbuild-tokyo/releases/download/v1.2.4/Grokbuild-Tokyo-1.2.4-win-x64.zip) · [全部版本](https://github.com/swf-cmd/grokbuild-tokyo/releases)**

<sub>免费开源 · 非官方 · 需另行安装官方 <a href="#安装-grok-build">Grok Build CLI</a></sub>

[快速开始](#快速开始) · [功能](#陪你把灵感写到深夜) · [常见问题](#常见问题) · [完整使用指南](docs/guide.zh-CN.md) · [参与贡献](CONTRIBUTING.zh-CN.md) · [反馈问题](https://github.com/swf-cmd/grokbuild-tokyo/issues/new/choose)

</div>

![Grokbuild Tokyo 中文欢迎界面，涩谷夜景中的雨滴动态演示](docs/images/welcome-zh-CN.gif?v=20260930)

*Windows 欢迎页雨滴动态演示，使用隔离的演示账户；Mac 使用原生窗口按钮和 Command 快捷键。[静态截图](docs/images/welcome-zh-CN.png?v=20260930) · [拍摄说明](docs/images/README.md)。*

[Grok Build](https://x.ai/cli) 是 SpaceXAI（原 xAI）推出的终端编程智能体。Grokbuild Tokyo 是它的**非官方开源桌面应用**：启动你本机安装的 Grok Build CLI，并通过 [Agent Client Protocol](https://agentclientprotocol.com/)（ACP）与之通信。登录、模型、工具、授权规则、MCP 服务和 Skills 都按 CLI 原有配置运行，应用只是为它们开了一扇值得一直亮着的窗。

本项目与 SpaceXAI 或 xAI 无隶属关系，也未获其背书。登录、模型访问和用量由官方 CLI 及你的账户处理。

## 陪你把灵感写到深夜

| 功能 | 你可以做什么 |
| --- | --- |
| **有氛围的工作空间** | 涩谷雨夜背景、可关闭的动态雨滴，以及原创离线合成器音乐。 |
| **多任务同时进行** | 最多四段对话并行生成，各自保留进度、授权请求、停止按钮和草稿。 |
| **持续积累的对话** | 流式 Markdown 与代码块、搜索与重命名、历史恢复和 Markdown 导出。 |
| **看得见的执行过程** | 查看工具进度和执行计划，逐项响应权限请求，随时停止生成。 |
| **独立账户管理** | 添加、登录、切换、重命名和删除账户，各自保存登录状态与聊天历史。 |
| **图片与文件** | 选择文件、将文件拖入消息输入区或粘贴图片，直接预览回复图片并保存返回的附件。 |
| **额度一目了然** | 在侧边栏查看当前账户的 Grok 额度已用多少、何时重置。 |
| **跟随官方引擎的控制** | 可选模型与推理档位来自 CLI 并自动更新，还可设置子代理与工作目录。 |
| **七种界面语言** | 中文、English、日本語、한국어、Español、Deutsch、Français。 |

![真实桌面界面中的中文演示对话，背景保留较淡的雨滴](docs/images/app-zh-CN.png?v=20260930)

*截图来自隔离的演示账户与模拟引擎，对话内容和额度数字仅作界面展示；可用模型和工具取决于你安装的 CLI。*

## 快速开始

你需要官方 Grok Build CLI、能够使用该服务的账户，以及适合你电脑的应用版本。

### 安装 Grok Build

使用官方安装脚本安装 CLI，或参阅[官方安装说明](https://github.com/xai-org/grok-build#installing-the-released-binary)：

```sh
# macOS
curl -fsSL https://x.ai/cli/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://x.ai/cli/install.ps1 | iex
```

如果你已在终端中登录过 Grok Build，应用会沿用保存在 `~/.grok` 中的登录与配置；否则可在首次启动时从应用内登录。

### 下载说明

**[前往最新 Release](https://github.com/swf-cmd/grokbuild-tokyo/releases/latest)**：公开下载，无需登录 GitHub。

| v1.2.4 下载 | 适用环境 | 校验文件 |
| --- | --- | --- |
| **[Mac 通用版 ZIP](https://github.com/swf-cmd/grokbuild-tokyo/releases/download/v1.2.4/Grokbuild-Tokyo-1.2.4-mac-universal.zip)** | macOS 13 Ventura 及以上 · Intel 与 Apple Silicon | [SHA-256](https://github.com/swf-cmd/grokbuild-tokyo/releases/download/v1.2.4/Grokbuild-Tokyo-1.2.4-mac-universal.zip.sha256) |
| **[Windows x64 便携版 ZIP](https://github.com/swf-cmd/grokbuild-tokyo/releases/download/v1.2.4/Grokbuild-Tokyo-1.2.4-win-x64.zip)** | Windows x64 · 完整应用文件夹，免安装 | [SHA-256](https://github.com/swf-cmd/grokbuild-tokyo/releases/download/v1.2.4/Grokbuild-Tokyo-1.2.4-win-x64.zip.sha256) |

- **Mac**：解压一次，将 **Grokbuild Tokyo.app** 拖入**应用程序**。应用使用临时签名（ad hoc），尚未使用 Developer ID 证书或经过 Apple 公证。如首次启动被 macOS 阻止，请确认下载来自本仓库，再按照**系统设置 → 隐私与安全性 → 仍要打开**操作（[Apple 说明](https://support.apple.com/en-us/102445)）。
- **Windows**：将 ZIP 完整解压到可写入的目录，运行 **`App\Grokbuild Tokyo.exe`**。请保留**整个 `App` 文件夹**；这是便携版，不是安装器。应用尚未进行代码签名。如果出现 SmartScreen 提示，请先核实下载来源；如果系统提供相应选项，可点击**更多信息 → 仍要运行**。
- 两版均已包含桌面运行环境，只有[从源码构建](#从源码构建)时才需要 Node.js。最低 macOS 版本来自 [Electron 44](https://www.electronjs.org/blog/electron-44-0)。客户端暂不将 Linux 作为支持目标。

<details>
<summary><b>校验下载文件</b></summary>

将 ZIP 与对应的 `.sha256` 文件保存在同一目录。Mac 上运行：

```sh
shasum -a 256 -c Grokbuild-Tokyo-1.2.4-mac-universal.zip.sha256
```

在 Windows PowerShell 中，将计算出的哈希值与 `.sha256` 文件中的值比对：

```powershell
Get-FileHash .\Grokbuild-Tokyo-1.2.4-win-x64.zip -Algorithm SHA256
Get-Content .\Grokbuild-Tokyo-1.2.4-win-x64.zip.sha256
```

</details>

### 首次启动

应用首次启动显示英文界面，以下按钮名称在括号中附上英文。

1. Windows 默认寻找 `%USERPROFILE%\.grok\bin\grok.exe`，Mac 默认寻找 `~/.grok/bin/grok`。如果安装在其他位置，在左下角**偏好设置**（Preferences）中选择对应的可执行文件；Mac 上选择不带 `.exe` 后缀的 `grok`。
2. 如果尚未保存登录，点击消息输入区上方的**登录 Grok ↗**（Sign in to Grok ↗），再点击**打开登录页面 ↗**（Open sign-in page ↗），在浏览器中登录并核对验证码；授权完成后应用会自动连接。需要更多账户时，使用**账户切换**（Switch account）添加。
3. 在**偏好设置**中选择项目目录，再开启新对话。Windows 默认使用打包后 `App` 文件夹旁的 `Workspace`（源码运行时位于源码目录中），Mac 默认使用 `~/Library/Application Support/Grokbuild Tokyo/Workspace`；已有会话保留各自原来的工作目录。

在 **Preferences → Interface language** 中选择中文并保存即可切换界面语言。桌面界面无需手动填写 API Key。

## 常见问题

<details>
<summary><b>这是官方应用吗？</b></summary>

不是。Grokbuild Tokyo 是采用 MIT 许可证的独立项目，与 SpaceXAI 或 xAI 无隶属关系，也未获其背书。它不内置、也不修改 CLI，只是启动你安装的 Grok Build CLI，并显示 CLI 返回的内容。

</details>

<details>
<summary><b>需要付费吗？</b></summary>

应用本身免费。请求由 Grok Build CLI 以你自己的账户发出，与在终端中使用时一样计入该账户的套餐或用量。

</details>

<details>
<summary><b>需要 API Key 吗？</b></summary>

不需要。从应用内登录使用 CLI 官方的浏览器登录流程（`grok login --device-auth`），界面中没有填写 Key 的地方。每个账户分别保存自己的 CLI 登录。

</details>

<details>
<summary><b>支持哪些 Grok Build 版本？</b></summary>

真实兼容性基线为 2026-09-07 在 Windows 上核查的 Grok Build **1.0.13 / ACP 1**。模型、推理档位等选项均从已连接的 CLI 读取，建议用 `grok update` 保持 CLI 为最新。客户端没有为所有终端功能提供界面，例如交互终端、Git/worktree 管理、会话分叉和斜杠菜单。详见[完整兼容说明](docs/guide.zh-CN.md#grok-兼容范围)。

</details>

<details>
<summary><b>可以发送图片和文件吗？</b></summary>

可以：每条消息最多 10 个文件，单个不超过 20 MB，合计不超过 50 MB。模型能读取哪些内容，取决于所安装 CLI 的能力、工具及权限。此前测试的 CLI 1.0.13 使用本地资源引用，由 CLI 工具读取附件。详见[附件支持范围与大小限制](docs/guide.zh-CN.md#聊天图片与附件)。

</details>

<details>
<summary><b>为什么首次打开时 macOS 或 Windows 会提示风险？</b></summary>

Mac 版只使用临时签名、未经公证，Windows 版未进行代码签名。请确认下载来自本仓库的 [Releases](https://github.com/swf-cmd/grokbuild-tokyo/releases)，必要时校验 SHA-256，再按照[下载说明](#下载说明)中的步骤打开。

</details>

<details>
<summary><b>应用会把我的数据发到别处吗？</b></summary>

聊天记录保存在你的电脑上。CLI 会像在终端中一样，把提示词和工具上下文发送给模型服务。除了加载回复中引用的图片和文件，应用自身唯一的网络请求是可选的额度卡片，可随时关闭。详见[它如何工作](#它如何工作)与[你的数据放在哪里](#你的数据放在哪里)。

</details>

## 常用快捷键

| Windows | Mac | 操作 |
| --- | --- | --- |
| `Enter` | `Enter` | 发送 |
| `Shift + Enter` | `Shift + Enter` | 换行 |
| `Ctrl + N` | `Cmd + N` | 新建会话 |
| `Ctrl + ,` | `Cmd + ,` | 偏好设置 |
| `Esc` | `Esc` | 关闭图片预览，或取消设置预览 |

## 它如何工作

```text
Grokbuild Tokyo（Electron 桌面界面）
          │
          │  通过本地进程使用 ACP
          ▼
你安装的 Grok Build CLI
          ├── 账户登录与模型请求
          ├── 项目文件、工具和授权规则
          └── MCP、Skills、插件和沙箱配置
```

客户端把自己的聊天记录和设置保存在本地，由 CLI 处理模型请求。它并非离线模型：CLI 可能将提示词与工具上下文发送给模型服务。

可选的额度卡片是客户端唯一使用你的 CLI 登录凭据发出的请求：它向 Grok Build 计费接口查询当前账户的用量，可在**偏好设置 → 显示账户额度**中关闭。详见[账户额度](docs/guide.zh-CN.md#账户额度)。

## 你的数据放在哪里

Windows 的 `data/` 位于源码根目录，或打包后 `App` 文件夹的旁边。Mac 使用 `~/Library/Application Support/Grokbuild Tokyo/data`，保存在 `.app` 之外，源码运行与打包程序共用该位置。它保存聊天、附件、设置，以及 CLI 写入的账户凭据。它存放在本地、被 Git 忽略，**本应用不额外加密这些文件**。本机账户也可能使用 `GROK_HOME`（默认 `~/.grok`）。独立账户隔离配置和历史，不提供操作系统级沙箱。

远程图片会向公开图片网站发起请求。权限、文件与网络访问边界见[安全说明](SECURITY.zh-CN.md)，各类文件的存放位置见[使用指南](docs/guide.zh-CN.md#本地数据与仓库内容)。请单独备份个人数据，不要将其放进 issue、截图或发布包。

## 从源码构建

需要 **Git**、**Node.js 22.13.0 或更高版本**及 npm；开发和 CI 使用 Node.js 24。安装依赖和首次构建需联网下载 Electron。

```sh
git clone https://github.com/swf-cmd/grokbuild-tokyo.git
cd grokbuild-tokyo
npm ci
npm start
```

之后按[首次启动](#首次启动)完成设置。开发检查见[贡献指南](CONTRIBUTING.zh-CN.md)。

<details>
<summary><b>打包桌面程序</b></summary>

先完全退出正在运行的客户端。Windows 上运行：

```powershell
npm run build
node scripts/verify-package.cjs
& '.\App\Grokbuild Tokyo.exe'
```

运行或分发 Windows 版时，请保留**整个 `App` 文件夹**。

Mac 上如有需要先安装 Apple 命令行工具（`xcode-select --install`），再构建同时适用 Intel 与 Apple Silicon 的通用版：

```sh
npm run build:mac
node scripts/verify-package.cjs --platform darwin --arch universal
open "App/Grokbuild Tokyo.app"
```

可分发文件为 `dist/Grokbuild-Tokyo-1.2.4-mac-universal.zip`，旁边附有 `.zip.sha256` 校验文件。也可用 `npm run build:mac:arm64` 或 `npm run build:mac:x64` 生成体积较小的单架构版本。`npm run build` 为当前电脑构建；Mac 上使用当前 Node.js 进程的架构。

Mac 构建使用本地临时签名（ad hoc），尚未使用 Developer ID 证书或经过 Apple 公证。两版共用相同界面和功能；Mac 增加原生窗口按钮与菜单。关闭 Mac 窗口后应用和正在进行的工作仍会运行，点击 Dock 图标可重新打开；按 **Cmd+Q** 完全退出。

构建只纳入明确列出的运行文件和许可证，旧 `App` 构建保存在 `work/package-backups`。源码仓库不附带预编译程序。

</details>

## 开发与贡献

```sh
npm test
npm run test:ui
npm run test:models
npm run test:security
```

默认测试使用隔离环境，不发送真实模型请求。CI 在配置的 Windows 与 Mac 运行器上检查账户、附件、语言、时钟、依赖和打包后的应用。[贡献指南](CONTRIBUTING.zh-CN.md)包含完整检查命令、贡献流程及需主动开启的真实模型测试说明。

欢迎反馈问题、提交范围清晰的修复、完善翻译和文档。敏感安全问题请使用 [GitHub 私密漏洞报告](https://github.com/swf-cmd/grokbuild-tokyo/security/advisories/new)。

如果 Grokbuild Tokyo 陪你度过了不少深夜，给仓库点个 Star，能帮更多人发现它。

## 许可证与致谢

[MIT 许可证](LICENSE) © 2026 swf-cmd and contributors。第三方组件保留原有许可证；内置库、Electron 和素材来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

涩谷雨夜背景由 AI 生成，[提示词随仓库提供](src/renderer/assets/IMAGE-PROMPT.md)。图标由 [`scripts/make-icon.py`](scripts/make-icon.py) 绘制；**Tokyo Afterimage · 東京残像**为原创合成器器乐，可从 [`scripts/ambient-score.js`](scripts/ambient-score.js) 重新生成。

使用 [Electron](https://www.electronjs.org/)、[Marked](https://github.com/markedjs/marked) 与 [DOMPurify](https://github.com/cure53/DOMPurify) 构建，通过 [ACP](https://agentclientprotocol.com/) 连接 [Grok Build](https://github.com/xai-org/grok-build)。
