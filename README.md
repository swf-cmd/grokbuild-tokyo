# Grokbuild Tokyo · 东京雨夜

为 Grok Build CLI 制作的非官方 Windows 桌面客户端。通过 ACP 连接本机安装的 Grok，提供雨夜背景、流式聊天、图片预览和独立账户管理。

当前版本：**1.2.1**。本仓库先用于私有开发，项目自身仍标记为 `UNLICENSED`；正式开源前再确定许可证。第三方组件声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 启动

需要 Windows x64、Node.js 22.12.0 或更高版本，以及已安装的 [Grok Build CLI](https://github.com/xai-org/grok-build)。开发与自动测试使用 Node.js 24。模型请求和登录由官方 CLI 处理。

```powershell
git clone https://github.com/swf-cmd/grokbuild-tokyo.git
cd grokbuild-tokyo
npm ci
npm start
```

默认在当前用户的 `%USERPROFILE%\.grok\bin\grok.exe` 查找 CLI。若安装在别处，打开左下角设置，选择 `grok.exe`。本机账户沿用 CLI 的登录和配置；未登录时可在“账户切换”中登录。

默认工作目录为项目中的 `Workspace`，首次启动自动创建。要处理已有项目，在设置中选择该目录，再新建会话；已有会话继续使用自己的原始工作目录。

```powershell
npm run build
& '.\App\Grokbuild Tokyo.exe'
```

构建前关闭正在运行的客户端。构建会更新 `App`；运行时需要保留整个 `App` 目录及其配套文件。安装依赖和首次构建需要联网下载 Electron。源码仓库不包含预编译程序或本机快捷方式。

## 账户管理

点击左下角“账户切换”查看账户、登录状态和邮箱。

- **添加并登录**：输入 1–60 字的名称，在浏览器中选择账户并核对验证码；成功后自动连接。名称不能与已有账户重复。
- **切换**：各账户使用独立的登录、配置和聊天历史，客户端记住上次使用的账户。本次运行中的草稿也按账户保留。
- **重命名**：在账户行点击“重命名”，只修改客户端显示名称。
- **删除**：新增账户可在账户行点击“删除”。确认后移除该账户的客户端聊天记录，以及客户端管理的本地登录、配置和 Grok 会话缓存。删除当前账户后自动切换回本机账户。操作不会注销远程 xAI 账户，也不会删除工作目录中的项目文件。
- **本机账户**：沿用 `GROK_HOME`（默认 `~/.grok`），可重命名和重新登录；不能在客户端删除，以免影响官方 CLI 的共享登录和数据。
- **登录失败或取消**：保留账户以便重试，也可删除未完成登录的新增账户。生成回复或账户操作进行期间，相冲突的操作会被禁用。

新增账户使用 `data/accounts/<账户 ID>/grok`，从官方默认配置开始，不复制本机凭据，也不继承本机 API Key 或登录覆盖环境变量。客户端偏好和默认工作目录为共享设置。

删除时若本地文件被占用导致清理未完成，界面会说明情况，重启时会再次尝试清理。该账户不会重新出现在账户列表。登录通过官方 `grok login --device-auth` 完成；界面不接收原始凭据或 CLI 登录输出。

若历史文件损坏，无法确认是否完成删除的目录会保存在 `data/accounts/.recovery-*`，不会自动清理，可结合 `conversations.json.unreadable-*` 备份手工恢复。隔离失败时客户端会阻止覆盖原历史文件，并提示先处理目录权限。

## 聊天与图片

支持流式回复、Markdown 和代码块、复制、对话搜索、重命名、导出 Markdown、工具进度、执行计划、逐项授权及停止生成。执行计划随 Grok 更新，并与聊天一起保存和导出；回复长度/请求次数达到上限或被拒绝时保留明确提示。Enter 发送；Shift+Enter 换行；Ctrl+N 新会话；Ctrl+, 设置。

Markdown 图片、图片链接、HTML 图片及 ACP 回复或工具返回的图片可直接显示。点击图片放大，Esc 关闭；加载失败可重试。支持网络图片、内嵌图片、当前会话工作目录与 Grok 缓存中的本地图片。相对路径先从工作目录查找，再查当前会话缓存。本地和内嵌图片上限 20 MB。

导出 Markdown 包含已记录的图片来源；本地图片路径仍依赖原文件。普通的“删除会话”只删除客户端记录，不删除 CLI 底层会话；这与“删除账户”的清理范围不同。

## 模型、配置与外观

在“偏好设置 → 界面语言”中切换 **中文、日本語、English、한국어、Español、Deutsch、Français**。选择后立即预览，点击“保存设置”后记住，下次启动继续使用；关闭设置或按 Esc 则恢复之前的语言。语言设置在账户之间共享，生成回复期间也能保存，不会重连引擎。切换仅影响界面和新选用的快捷提示，不修改已有聊天、账户名称或未发送的草稿。

模型和思考强度沿用 CLI 返回的顺序、ID 和支持范围，常见推理档位名称按界面语言显示，未知自定义名称保留原文。客户端在引擎确认并回读后显示切换结果，恢复历史时重新同步。无法确认的选择显示“待确认”。

兼容的旧版 CLI 使用 `session/set_model` 的 `_meta.reasoningEffort` 切换推理档位并载入会话回读；支持 `session/set_config_option` 的 CLI 使用该接口。`session/set_mode` 不作为推理档位切换接口。

“允许使用子代理”通过 `GROK_SUBAGENTS=1/0` 传给 CLI，保存后重启独立引擎。权限、沙箱和 MCP 沿用官方配置优先级；客户端不改写官方 `config.toml`。修改官方配置后重新连接。

“东京午夜电台”播放随软件附带的原创合成器器乐《Tokyo Afterimage · 東京残像》，80 BPM、96 秒循环，无需联网。默认开启、音量 90%；若启动时尚未播放，点击窗口或按键即可开始。雨景、音乐和音量即时预览，保存后记住，关闭设置则还原。氛围设置可在生成回复期间保存，不重启引擎。系统启用“减少动态效果”时停止雨滴动画。

## 本地数据与仓库内容

| 路径 | 用途 | 上传 Git |
| --- | --- | --- |
| `src` | 主进程、ACP 适配器、账户管理和界面 | 是 |
| `scripts`、`tests` | 构建、回归测试和隔离的模拟引擎 | 是 |
| `licenses` | 随源码分发的第三方许可文本 | 是 |
| `data` | 登录、客户端聊天、设置、浏览器缓存 | 否 |
| `Workspace` | 默认项目工作目录 | 否 |
| `App` | 本地构建产物 | 否 |
| `work` | 测试数据、截图、开发备份 | 否 |
| `node_modules` | 安装的开发依赖 | 否 |

`data` 包含个人数据，迁移或备份客户端时应单独保存。首次克隆不会带入开发者的账户、聊天或配置。客户端启用了渲染进程隔离、沙箱和有限 IPC；本地图片读取仅限当前会话允许的目录。

## 验证与开发

```powershell
npm test
npm run test:ui
npm run test:accounts
npm run test:i18n
npm run build
node scripts/images-accounts-smoke.cjs --packaged
node tests/i18n-ui.cjs --packaged
```

单元测试覆盖 ACP、模型与配置、会话持久化、图片路径、账户隔离、登录生命周期、名称校验、账户删除及失败恢复，以及七种语言的词条完整性、参数插值与默认语言处理。界面测试使用真实 Electron 主进程、IPC 和界面，替换 CLI 和登录为隔离的模拟引擎；不会调用真实模型或修改日常账户。账户界面测试覆盖添加、登录、重命名、删除确认、自动切换、重启恢复及 980 × 680 布局。语言界面测试检查七种语言的即时预览、保存与取消、重启恢复、辅助标签、动态状态、对话和草稿保留、生成期间切换及紧凑窗口布局。GitHub Actions 在 Windows 上运行上述检查，并验证打包后的语言功能。

额外检查：`node scripts/packaged-smoke.cjs` 验证打包后的通用界面，`node scripts/ambience-smoke.cjs` 验证音乐与雨景，后者也支持 `--packaged`。

真实 CLI 检查需单独运行 `node scripts/config-smoke.cjs`；真实模型测试包括 `node scripts/ui-smoke.cjs --live`、设置 `GROK_LIVE_TEST=1` 后的 `node tests/live-smoke.cjs`（可加 `--permission`），以及设置 `GROK_CONFIG_LIVE_TEST=1` 后的 `node tests/live-config-smoke.cjs`。这些不属于默认测试，会使用本机登录和账户用量。

### Grok 兼容范围

当前核查对象为 Windows 本机 Grok Build **1.0.13 / ACP 1**。聊天、会话恢复、模型/推理切换、工具执行、权限请求和子代理通过官方 CLI；文件读写、终端、MCP、Skills、插件和沙箱由 CLI 按自身配置处理，客户端不宣称接管文件或终端执行。权限提示是否出现取决于官方权限模式、规则和已保存授权。

该版本通过 ACP 宣告 `image: false`、`audio: false`，客户端据此提供文本输入，仍支持回复中的图片预览。客户端没有为所有 `x.ai/*` 扩展或 TUI 专用命令提供独立界面（例如 Git/worktree 管理、会话分叉/回退、交互终端与斜杠菜单），不能等同于官方 TUI 的全部功能。遇到不兼容的协议或不支持历史恢复的引擎，现在会明确提示。

背景为生成的涩谷雨夜图，提示词见 [IMAGE-PROMPT.md](src/renderer/assets/IMAGE-PROMPT.md)。图标由 `scripts/make-icon.py` 绘制（需 Python 与 Pillow）；背景音乐可用 `node scripts/render-ambience.cjs` 从 `scripts/ambient-score.js` 重新生成。

## 协议与官方参考

- [Grok Build](https://github.com/xai-org/grok-build)
- [Grok 认证说明](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md)
- [Grok 配置说明](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/05-configuration.md)
- [Grok 子代理说明](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md)
- [ACP 内容协议](https://agentclientprotocol.com/protocol/v1/content)
- [Electron 安全说明](https://www.electronjs.org/docs/latest/tutorial/security)
