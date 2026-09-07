# Security policy

English · [简体中文](SECURITY.zh-CN.md)

Grokbuild Tokyo is an unofficial local interface for Grok Build CLI. Security fixes target the latest version on the default branch; older versions do not have a separate maintenance commitment. Check whether an issue still occurs on the latest version when it is safe to do so.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/swf-cmd/grokbuild-tokyo/security/advisories/new) when available. If that page is unavailable, open an issue asking for a private reporting channel **without disclosing vulnerability details**. Wait for a private channel before sharing a proof of concept or sensitive logs.

Include the affected application and CLI versions, Windows version, minimal reproduction steps, expected and actual behavior, and the potential impact. Remove credentials, personal conversations, account identifiers, and private file contents from all attachments. Please allow time to investigate and prepare a fix before public disclosure; no fixed response time is promised.

## Trust and data boundaries

- The renderer enables context isolation, sandboxing, and a Content Security Policy. The main process exposes limited IPC to the main window's main frame. Reply HTML uses tag and attribute allowlists. Permission requests use non-reusable client IDs; a response must match an option from the active request.
- The CLI, working directory, and tools you authorize still operate with the current system user's permissions. Separate accounts isolate configuration and history; they are not operating-system security sandboxes. The client does not override the official CLI's authorization rules. Understand your CLI configuration before running it.
- `data/` contains conversations, attachments, account configuration, and credentials saved by the CLI. This application does not add encryption to those files. Do not upload this directory or include it in a shared build. Other processes running as the same system user can read these files.
- Local images and reply attachments can only be read from the current session's working directory, corresponding cache, or account attachment directory. Reads check the real path and the opened file's identity and impose size limits. These restrictions do not prevent an authorized CLI tool from reading other files itself.
- Remote images and attachments only connect to public HTTP/HTTPS addresses. Every redirect and the DNS results used for the actual connection are checked; private, loopback, link-local, and other special-use addresses are rejected. Each download is limited to 20 MB and a total of 60 seconds. Downloads do not carry browser cookies or use environment proxies. Remote images are checked for a supported format and displayed as data URLs.
- Public images can trigger automatic network requests, exposing connection information to their source websites. HTTP does not provide HTTPS transport protection. Resources that require browser login, an environment proxy, LAN access, or a forcibly compressed response may not load.
- Web links open in the system browser. Only HTTP/HTTPS links are allowed; browser authentication and activity are handled outside the client.

## Checks before a release

```powershell
npm ci
npm test
npm run test:security
npm audit --audit-level=moderate
npm run build
node scripts/verify-package.cjs
node tests/ui-security.cjs --packaged
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete UI and packaged checks. Default tests use isolated mock CLI/login behavior and do not execute real model requests. Live checks are separate, require local CLI access, and can consume account usage.

Packaging uses an explicit file allowlist, rejects symbolic links in that list, and replaces the entire output directory. The previous `App/` directory is retained under `work/package-backups/`. Scan the full Git history and final distribution for private data before a release; `.gitignore` alone is insufficient. Passing checks for one revision does not establish that future changes or release files are safe.
