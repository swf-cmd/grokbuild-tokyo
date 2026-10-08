# Contributing to Grokbuild Tokyo

English · [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for helping improve this unofficial Windows and Mac desktop client for Grok Build CLI. Bug reports, documentation, translations, accessibility improvements, and focused code changes are welcome.

## Before you start

- Read the [README](README.md) for supported behavior and the [security policy](SECURITY.md) for the application's trust boundaries.
- Search existing issues and pull requests before opening a new one. For a substantial feature or architectural change, describe the proposed behavior in an issue first.
- Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), without putting exploit details in a public issue.
- Keep reports and discussions respectful and specific. Never include credentials, private conversations, or other people's personal data.

## Development setup

Use Windows x64 or macOS 13+ on Intel or Apple Silicon, with Node.js 22.13.0 or newer. CI uses Node.js 24; use that version when reproducing CI failures. The locally installed [Grok Build CLI](https://github.com/xai-org/grok-build) is required for normal application use, while the default automated tests use isolated mock engines.

Fork this repository, clone your fork, and create a branch for your change:

```sh
git clone https://github.com/YOUR-USERNAME/grokbuild-tokyo.git
cd grokbuild-tokyo
git switch -c describe-your-change
npm ci
npm start
```

Installation and the first build need network access to download dependencies and Electron. Windows defaults to `%USERPROFILE%\.grok\bin\grok.exe`; Mac defaults to `~/.grok/bin/grok`, with common installation paths as fallbacks. Select your executable in settings if necessary. On Mac, packaging requires Apple Command Line Tools (`xcode-select --install`).

Mac source and packaged runs share `~/Library/Application Support/Grokbuild Tokyo` for `data/` and `Workspace/`. Tests use isolated roots; use those fixtures when checking account or history changes. Windows keeps its existing data layout in the checkout or beside `App/`.

## Make a focused change

- Follow the surrounding code style and keep unrelated formatting changes out of the pull request.
- Add or update meaningful regression coverage when changing behavior. Include screenshots for visible UI changes, using demo data only.
- Keep English and Chinese documentation aligned. Changes to interface text should cover all seven UI languages and pass the internationalization checks. Keep Windows and Mac feature behavior aligned; platform-specific window controls, menus, paths, and modifier keys are intentional.
- Preserve account isolation, limited IPC, reply sanitization, permission handling, and local/remote resource restrictions. Account separation is not an operating-system sandbox; tool execution is controlled by the official CLI.
- Do not commit `data/`, `Workspace/`, `App/`, `dist/`, `work/`, `node_modules/`, environment files, login output, or personal screenshots. Check the staged diff as well as `.gitignore`.
- Retain third-party notices and license files. Describe the source and license of any new dependency or media asset.

## Validate your change

Run the checks relevant to the change locally. CI runs the shared checks on Windows x64 and Mac Intel/Apple Silicon runners. `npm run build` selects the host platform (and the current Node.js architecture on Mac):

```sh
npm ci
npm run test:all
npm audit --audit-level=moderate
npm run build
npm run test:packaged
```

`test:all` runs ESLint, JavaScript type checking, unit tests, and every offline UI suite, including renderer performance and image loading near the viewport. `test:packaged` verifies the archive inventory and release fuses, launches the actual hardened binary, and repeats the fixture suites against its ASAR resources. Both runners stop at the first failure and invoke Node directly, so they work in Windows and macOS shells. Use `-- --list` to inspect the commands without running them; existing individual test commands remain available.

`npm run lint` covers authored JavaScript (excluding vendored/generated files). `npm run typecheck` uses `checkJs` and `noEmit` for the path, model, quota, blob and history modules plus packaging and test-runner scripts; `tsconfig.json` lists this incremental coverage explicitly. Extend it when moving more controller or UI behavior into modules. These checks add no application runtime dependency. Development requires Node.js 22.13.0+ for the supported ESLint release; CI uses Node.js 24.

Release packaging disables `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and Node inspector arguments with Electron Fuses, and enforces embedded ASAR integrity and ASAR-only loading. Fuses are applied after universal merging and before the final macOS signature. The actual-binary smoke test uses renderer CDP so the production inspector fuse stays disabled; fixture tests continue to cover native lifecycle and menu behavior using development Electron. CI builds the universal Mac ZIP once on Apple Silicon and runs that same archive on Intel.

Quit the running client before building (**Cmd+Q** on Mac; closing its window only hides it). The build replaces the entire `App/` directory and saves the previous directory under `work/package-backups/`. Windows distributions need the complete `App/` directory and its license files.

For a Mac release, build the universal app on a Mac and validate both architectures:

```sh
npm run build:mac
npm run test:packaged -- --platform darwin --arch universal
```

This creates `App/Grokbuild Tokyo.app` and `dist/Grokbuild-Tokyo-1.2.4-mac-universal.zip` with a `.zip.sha256` checksum. `npm run build:mac:arm64` and `npm run build:mac:x64` produce individual architecture builds.

`npm run build:win` explicitly targets Windows x64 and creates `dist/Grokbuild-Tokyo-1.2.4-win-x64.zip` plus its `.zip.sha256` checksum. This is a portable archive, not an installer: extract the complete `App/` folder and launch `App/Grokbuild Tokyo.exe`. The archive retains the runtime license files and excludes development `data/` and `Workspace/` directories. Windows uses the built-in PowerShell `Compress-Archive`; macOS cross-builds use `ditto` (Linux cross-builds require `zip`).

Mac packages are ad-hoc signed, without a Developer ID certificate or notarization. Do not label them as notarized releases. See the [user guide](docs/guide.md#getting-started) for installation and first-launch behavior. Validate a universal package on both architectures before claiming runtime coverage for both; inspecting its Mach-O slices alone is not a runtime test.

Default unit and UI tests use mock CLI/login behavior and isolated test data; they do not make real model requests or modify your everyday account. Dependency audit results cover known registry advisories and do not replace code or runtime review.

**Live checks are separate and opt-in.** `node scripts/config-smoke.cjs` uses the real CLI. `node scripts/ui-smoke.cjs --live`, `node tests/live-smoke.cjs` with `GROK_LIVE_TEST=1`, and `node tests/live-config-smoke.cjs` with `GROK_CONFIG_LIVE_TEST=1` use your local CLI login and can consume account usage. Do not enable them in routine CI or run them against somebody else's account.

## Submit a pull request

Explain the problem, the resulting behavior, and the checks you ran. Link the relevant issue if there is one, and call out any remaining limitations. Keep secrets and personal information out of screenshots, logs, and test fixtures.

By submitting a contribution, you agree that your contribution is provided under the project's [MIT License](LICENSE). Only submit work you have the right to contribute.
