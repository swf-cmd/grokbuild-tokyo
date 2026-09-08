# 安全说明

[English](SECURITY.md) · 简体中文

Grokbuild Tokyo 是 Grok Build CLI 的非官方本地界面。安全修复以默认分支的最新版本为目标，不承诺单独维护旧版本。在安全可行的情况下，请确认问题是否仍会在最新版本中出现。

## 漏洞反馈

若入口可用，请使用 [GitHub 私密漏洞报告](https://github.com/swf-cmd/grokbuild-tokyo/security/advisories/new)。若无法访问，请先提交一个**不包含漏洞细节**的 issue，请维护者提供私密联系渠道。获得私密渠道后再提供概念验证代码或敏感日志。

报告请包含受影响的应用与 CLI 版本、Windows 或 macOS 版本、CPU 架构、最小复现步骤、预期与实际行为，以及可能造成的影响。附件应去除凭据、个人聊天、账户标识及私人文件内容。请在公开披露前留出调查和修复时间；项目不承诺固定响应时限。

## 信任与数据边界

- 渲染进程启用上下文隔离、沙箱和 CSP，主进程仅接受主窗口主框架的有限 IPC。回复 HTML 使用标签和属性允许列表；权限请求使用不可复用的客户端 ID，授权选择必须来自当前请求提供的选项。
- CLI、工作目录以及用户批准执行的工具仍具有当前系统用户的权限。独立账户提供配置和历史隔离，不是操作系统级安全沙箱。客户端不会覆盖官方 CLI 的授权规则；运行前应理解自己的 CLI 配置。
- `data/` 包含聊天、附件、账户配置和 CLI 保存的凭据。Windows 上位于源码根目录或打包后 `App/` 的旁边；Mac 上位于 `~/Library/Application Support/Grokbuild Tokyo/data`，源码运行和打包程序共用该位置，并保存在 `.app` 之外。本应用不额外加密这些文件。不要上传该目录或将其放入共享发布包。以相同系统用户运行的其他进程可读取这些本地文件。
- 本地图片和回复附件仅允许读取当前会话的工作目录、对应缓存或账户附件目录。读取时检查真实路径及打开文件的身份，并限制读取长度。该机制不能阻止已经获准运行的 CLI 自己读取其他文件。
- 远程图片和附件只连接公开 HTTP/HTTPS 地址，逐次验证重定向及实际连接的 DNS 结果，拒绝私网、回环、链路本地等特殊用途地址。每次下载最多 20 MB、总计 60 秒，不携带浏览器 Cookie，不使用环境代理；远程图片经过支持格式检查后以 data URL 显示。
- 公开图片可能自动发起网络请求，来源网站可看到连接信息；HTTP 不提供 HTTPS 的传输保护。需要浏览器登录、环境代理、局域网访问或强制压缩响应的资源可能无法加载。
- 网页链接交给系统浏览器打开，仅允许 HTTP/HTTPS。浏览器中的登录和网页行为在客户端之外处理。

## 发布前检查

```sh
npm ci
npm test
npm run test:security
npm audit --audit-level=moderate
npm run build
node scripts/verify-package.cjs
node tests/ui-security.cjs --packaged
```

请在每个支持的平台执行对应的本机检查。Mac 通用版使用 `npm run build:mac` 和 `node scripts/verify-package.cjs --platform darwin --arch universal`，并分别在 Intel 和 Apple Silicon 上验证运行行为。完整的界面回归及打包后测试见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。默认测试使用隔离的模拟 CLI/登录行为，不执行真实模型请求。真实检查需单独运行，需要本机 CLI 访问权限，并可能消耗账户用量。

Mac 构建使用本地临时签名（ad hoc），这不代表具有 Developer ID 身份或经过 Apple 公证。Mac ZIP 压缩包另附 SHA-256 校验文件，可用于完整性检查。

构建使用明确的源码文件清单，拒绝清单中的符号链接，并整体替换输出目录；旧 `App/` 保存在 `work/package-backups/`。发布新版本时应扫描完整 Git 历史和最终发布文件，不要只依赖 `.gitignore`。某个版本通过检查，并不意味着以后的提交或发行包自动安全。
