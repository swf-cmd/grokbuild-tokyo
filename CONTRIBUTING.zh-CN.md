# 参与 Grokbuild Tokyo

[English](CONTRIBUTING.md) · 简体中文

欢迎帮助改进这个 Grok Build CLI 的非官方 Windows 桌面客户端。你可以反馈问题、完善文档和翻译、改进无障碍体验，或提交聚焦具体问题的代码改动。

## 开始之前

- 阅读 [README](README.zh-CN.md)，了解支持的功能；阅读[安全说明](SECURITY.zh-CN.md)，了解应用的信任边界。
- 提交前搜索已有 issue 和 pull request。较大的功能或架构调整，请先用 issue 说明希望实现的行为。
- 漏洞请按照 [SECURITY.zh-CN.md](SECURITY.zh-CN.md) 中的私密流程反馈，不要在公开 issue 中发布可利用的细节。
- 讨论请保持尊重，描述具体问题。不要提交凭据、私人聊天或他人的个人信息。

## 开发环境

需要 Windows x64 和 Node.js 22.12.0 或更高版本。CI 使用 Node.js 24；复现 CI 问题时建议使用相同版本。正常使用应用需要本机安装 [Grok Build CLI](https://github.com/xai-org/grok-build)，默认自动测试则使用隔离的模拟引擎。

Fork 仓库，克隆自己的分支仓库，然后创建用于修改的分支：

```powershell
git clone https://github.com/YOUR-USERNAME/grokbuild-tokyo.git
cd grokbuild-tokyo
git switch -c describe-your-change
npm ci
npm start
```

安装依赖和首次构建需要联网下载依赖及 Electron。若 CLI 不在 `%USERPROFILE%\.grok\bin\grok.exe`，可在应用设置中选择实际的 `grok.exe`。

## 修改约定

- 遵循相邻代码的风格，避免在同一个 pull request 中混入无关格式调整。
- 修改行为时，补充或更新有意义的回归测试。涉及界面变化时附上截图，仅使用演示数据。
- 中英文文档应保持一致。修改界面文案时覆盖全部七种界面语言，并通过国际化检查。
- 保留账户隔离、有限 IPC、回复内容净化、权限处理和本地/远程资源访问限制。账户隔离不是操作系统沙箱；工具执行仍由官方 CLI 控制。
- 不要提交 `data/`、`Workspace/`、`App/`、`work/`、`node_modules/`、环境变量文件、登录输出或私人截图。除检查 `.gitignore` 外，也应核对暂存的 diff。
- 保留第三方声明与许可文件。新增依赖或媒体素材时说明来源与许可证。

## 验证修改

在本机运行与修改相关的检查。Windows CI 会执行以下完整流程：

```powershell
npm ci
npm test
npm audit --audit-level=moderate
npm run test:ui
npm run test:security
npm run test:accounts
npm run test:attachments
npm run test:i18n
npm run test:time
npm run build
node scripts/verify-package.cjs
node tests/ui-security.cjs --packaged
node scripts/images-accounts-smoke.cjs --packaged
node tests/i18n-ui.cjs --packaged
node tests/ui-attachments.cjs --packaged
node tests/time-ui.cjs --packaged
```

构建前关闭正在运行的客户端。构建会整体替换 `App/`，并将旧目录保存在 `work/package-backups/`。分发程序时保留完整输出目录及其许可文件。

默认单元和界面测试使用模拟 CLI/登录行为及隔离的测试数据，不会请求真实模型，也不会修改日常账户。依赖审计只能检查注册表中已知的漏洞，不能代替代码和运行时检查。

**真实 CLI 与模型检查需要单独选择运行。** `node scripts/config-smoke.cjs` 使用真实 CLI。`node scripts/ui-smoke.cjs --live`、设置 `GROK_LIVE_TEST=1` 后的 `node tests/live-smoke.cjs`，以及设置 `GROK_CONFIG_LIVE_TEST=1` 后的 `node tests/live-config-smoke.cjs` 会使用本机 CLI 登录，并可能消耗账户用量。不要在常规 CI 中启用，也不要使用他人的账户执行。

## 提交 pull request

说明原有问题、修改后的行为和已执行的检查；如有相关 issue，请附上链接。说明仍存在的限制。截图、日志和测试数据都应去除凭据与个人信息。

提交贡献即表示同意以项目的 [MIT 许可证](LICENSE) 提供该贡献。请只提交你有权贡献的内容。
