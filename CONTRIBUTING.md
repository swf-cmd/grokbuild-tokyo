# Contributing to Grokbuild Tokyo

English · [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for helping improve this unofficial Windows desktop client for Grok Build CLI. Bug reports, documentation, translations, accessibility improvements, and focused code changes are welcome.

## Before you start

- Read the [README](README.md) for supported behavior and the [security policy](SECURITY.md) for the application's trust boundaries.
- Search existing issues and pull requests before opening a new one. For a substantial feature or architectural change, describe the proposed behavior in an issue first.
- Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), without putting exploit details in a public issue.
- Keep reports and discussions respectful and specific. Never include credentials, private conversations, or other people's personal data.

## Development setup

Use Windows x64 and Node.js 22.12.0 or newer. CI uses Node.js 24; use that version when reproducing CI failures. The locally installed [Grok Build CLI](https://github.com/xai-org/grok-build) is required for normal application use, while the default automated tests use isolated mock engines.

Fork this repository, clone your fork, and create a branch for your change:

```powershell
git clone https://github.com/YOUR-USERNAME/grokbuild-tokyo.git
cd grokbuild-tokyo
git switch -c describe-your-change
npm ci
npm start
```

Installation and the first build need network access to download dependencies and Electron. Use the app's settings to select `grok.exe` if it is not installed at `%USERPROFILE%\.grok\bin\grok.exe`.

## Make a focused change

- Follow the surrounding code style and keep unrelated formatting changes out of the pull request.
- Add or update meaningful regression coverage when changing behavior. Include screenshots for visible UI changes, using demo data only.
- Keep English and Chinese documentation aligned. Changes to interface text should cover all seven UI languages and pass the internationalization checks.
- Preserve account isolation, limited IPC, reply sanitization, permission handling, and local/remote resource restrictions. Account separation is not an operating-system sandbox; tool execution is controlled by the official CLI.
- Do not commit `data/`, `Workspace/`, `App/`, `work/`, `node_modules/`, environment files, login output, or personal screenshots. Check the staged diff as well as `.gitignore`.
- Retain third-party notices and license files. Describe the source and license of any new dependency or media asset.

## Validate your change

Run the checks relevant to the change locally. The Windows CI workflow runs this complete set:

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

Close the running client before building. The build replaces the entire `App/` directory and saves the previous directory under `work/package-backups/`. Distribute the complete output directory with its license files.

Default unit and UI tests use mock CLI/login behavior and isolated test data; they do not make real model requests or modify your everyday account. Dependency audit results cover known registry advisories and do not replace code or runtime review.

**Live checks are separate and opt-in.** `node scripts/config-smoke.cjs` uses the real CLI. `node scripts/ui-smoke.cjs --live`, `node tests/live-smoke.cjs` with `GROK_LIVE_TEST=1`, and `node tests/live-config-smoke.cjs` with `GROK_CONFIG_LIVE_TEST=1` use your local CLI login and can consume account usage. Do not enable them in routine CI or run them against somebody else's account.

## Submit a pull request

Explain the problem, the resulting behavior, and the checks you ran. Link the relevant issue if there is one, and call out any remaining limitations. Keep secrets and personal information out of screenshots, logs, and test fixtures.

By submitting a contribution, you agree that your contribution is provided under the project's [MIT License](LICENSE). Only submit work you have the right to contribute.
