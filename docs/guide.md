# Grokbuild Tokyo user guide

[简体中文](guide.zh-CN.md) · [Back to the project](../README.md)

Grokbuild Tokyo is an unofficial Windows and Mac desktop client for Grok Build CLI. It connects to your locally installed Grok through ACP, with a rainy Tokyo backdrop, streaming chat, image and file uploads, downloadable reply attachments, and separate account profiles.

Current version: **1.2.4**. The project uses the [MIT License](../LICENSE). See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for component notices and [SECURITY.md](../SECURITY.md) for security boundaries and vulnerability reporting.

## Getting started

You need Windows x64 or **macOS 13 Ventura or newer on Intel or Apple Silicon**, and an installed [Grok Build CLI](https://github.com/xai-org/grok-build). The Mac universal app contains both architectures. macOS 13 is the minimum required by [Electron 44](https://www.electronjs.org/blog/electron-44-0); the [official Grok changelog](https://x.ai/build/changelog) documents Intel and Apple Silicon CLI support. The official CLI handles authentication and model requests.

Running from source or building also requires Git, Node.js 22.12.0 or newer, and npm. Development and automated tests use Node.js 24. The packaged app bundles Electron and does not need a separate Node.js installation.

```sh
git clone https://github.com/swf-cmd/grokbuild-tokyo.git
cd grokbuild-tokyo
npm ci
npm start
```

By default, the client looks for `%USERPROFILE%\.grok\bin\grok.exe` on Windows or `~/.grok/bin/grok` on Mac. If your CLI is elsewhere, open settings in the lower-left corner and select the executable (`grok` without a `.exe` extension on Mac). The local account uses the CLI's existing login and configuration; open **Switch account** to sign in if needed.

The default working directory is `Workspace` inside the source project on Windows (beside `App` when packaged), or `~/Library/Application Support/Grokbuild Tokyo/Workspace` on Mac, created on first launch. To work on an existing project, select its folder in settings and start a new conversation. Existing conversations keep their original working directories.

On Windows:

```powershell
npm run build
& '.\App\Grokbuild Tokyo.exe'
```

Keep the complete `App` directory and its accompanying files when running or distributing the Windows version.

On Mac, install Apple Command Line Tools if needed (`xcode-select --install`), then build the universal app:

```sh
npm run build:mac
node scripts/verify-package.cjs --platform darwin --arch universal
open "App/Grokbuild Tokyo.app"
```

The build creates `App/Grokbuild Tokyo.app` and `dist/Grokbuild-Tokyo-1.2.4-mac-universal.zip`, plus a `.zip.sha256` checksum file. Unzip the archive and drag **Grokbuild Tokyo.app** to **Applications**. The `.app` includes its runtime files and licenses. For a smaller, single-architecture build, use `npm run build:mac:arm64` on Apple Silicon or `npm run build:mac:x64` for Intel. Both can be built on a Mac. `npm run build` targets the host platform and, on Mac, the current Node.js architecture; `npm run build:win` explicitly selects Windows x64.

Mac builds use an ad-hoc local signature. They are not Developer ID signed or Apple notarized. For a downloaded copy whose source you trust, macOS may require **System Settings → Privacy & Security → Open Anyway**; follow [Apple’s instructions](https://support.apple.com/en-us/102445).

The Mac version shares the Windows interface, seven languages, account management, chat, tools, attachments, rain, and music. It adds native Mac window controls and an application menu. The red close button and **Cmd+W** hide the window while the app and any ongoing work remain running; click the Dock icon to reopen it. Use **Cmd+Q** or the app menu’s **Quit** command to fully exit.

Quit the running client before building. Packaging includes only explicitly listed runtime files and replaces the entire `App` directory, saving the old directory under `work/package-backups` for recovery. Dependency installation and the first build need network access to download Electron. The source repository does not include prebuilt apps or local shortcuts.

## Account management

Open **Switch account** in the lower-left corner to view accounts, login status, and email addresses.

- **Add and sign in:** enter a unique name of 1–60 characters, choose the account in your browser, and check the verification code. The client connects automatically after a successful login.
- **Switch:** each account has separate authentication, configuration, and chat history. The client remembers the last account used. During the current app run, drafts are also kept separately for each account.
- **Rename:** select **Rename** on an account row to change its display name in this client.
- **Delete:** accounts you added have a **Delete** action. After confirmation, the client removes that account's chat history and the local login, configuration, and Grok session cache it manages. Deleting the active account switches back to the local account. This does not delete your remote xAI account or project files in the working directory.
- **Local account:** uses `GROK_HOME`, which defaults to `~/.grok`. You can rename it or sign in again, but cannot delete it through the client, to avoid affecting the official CLI's shared login and data.
- **Failed or canceled login:** the account remains available for another attempt. You can also delete an added account that has not finished signing in. Conflicting actions are disabled while a reply or account operation is in progress.

Added accounts use `data/accounts/<account ID>/grok` and start with the official default configuration. They do not copy local credentials or inherit the local API key or authentication-override environment variables. Client preferences and the default working directory are shared across accounts.

If a file is in use and deletion cannot finish, the interface explains the problem and cleanup is retried on restart. The deleted account does not reappear in the list. Login uses the official `grok login --device-auth` flow; the interface does not receive raw credentials or the CLI's raw login output.

If the history file is corrupt, account directories whose deletion status cannot be established are preserved under `data/accounts/.recovery-*` and are not automatically removed. They can be recovered manually together with the `conversations.json.unreadable-*` backup. If the client cannot isolate those directories, it prevents the original history file from being overwritten and asks you to resolve directory permissions first.

## Chat, images, and attachments

The client supports streaming replies, Markdown and code blocks, copying, conversation search, renaming, Markdown export, tool progress, execution plans, individual permission prompts, and stopping generation. Execution plans update with Grok and are saved and exported with the conversation. Explicit notices remain visible when a reply or request limit is reached or a request is refused. Press **Enter** to send, **Shift+Enter** for a new line, **Ctrl+N** on Windows or **Cmd+N** on Mac for a new conversation, and **Ctrl+,** on Windows or **Cmd+,** on Mac for settings.

Use the paperclip beside the composer to select images or files, drag files into the window, or paste clipboard images. Preview or remove attachments before sending; a message can contain attachments without text. Each message allows up to **10 files**, **20 MB per file**, and **50 MB in total**. During the current app run, unsent attachment drafts are preserved separately by conversation and account.

Attachments are copied to the account directory managed by the client, so sent copies remain available if the original files move. CLI 1.0.13 does not support native ACP image input. The client therefore sends local resource references for the official `read_file` tool to read; this path was verified on Windows with real PNG and TXT files. That historical live check does not establish live model validation on Mac. When a CLI advertises image input support, the client uses embedded ACP images. Support for other file formats depends on the CLI's available tools and permissions.

ACP file resources, embedded text/binary attachments, and Markdown file links in replies appear as attachment cards that can be saved. File resources from read tools stay in tool content and are not automatically added as reply attachments; these echoes are also filtered when older history is loaded. User uploads, generated tool output, and files explicitly returned by Grok are retained. Select **Save attachment** and choose a destination. Remote files are downloaded at that point; local files can only be read from that conversation's working directory, Grok session cache, or current account's attachment directory. Downloads also have a 20 MB limit. Chat history and Markdown exports retain attachment sources.

Images in Markdown, image links, HTML images, and images returned in ACP replies or by generation tools can be displayed directly. Images returned by read tools stay in tool content instead of being appended to the final reply; loading history also filters images mistakenly appended by older versions. Click an image to enlarge it, press **Esc** to close, and retry if loading fails. Supported sources include remote URLs, embedded images, and local images in the current conversation's working directory or Grok cache. Relative paths are resolved in the working directory first, then the current session cache. Local and embedded images have a 20 MB limit.

Markdown exports include recorded image sources; local image paths still depend on the original files. Ordinary conversation deletion removes only the client's record, not the underlying CLI session. Account deletion has the broader cleanup scope described above.

Remote images and attachments accept only public HTTP/HTTPS addresses. The client checks every redirect and the DNS addresses used for the actual connection, rejecting localhost, private networks, and special-use addresses. Main-process downloads are limited to 20 MB and 60 seconds in total; images are format-checked before display. Downloads do not share browser cookies or use environment proxies. LAN services and sites requiring a proxy or browser login may be inaccessible. A server that ignores `Accept-Encoding: identity` and forces compression produces an explicit error. Public images still make requests to their source websites. Reply HTML cannot create application controls or inject application IDs or CSS classes.

## Models, configuration, and appearance

The interface defaults to **English** on first use and preserves any existing valid language preference. Under **Preferences → Interface language**, choose **中文、日本語、English、한국어、Español、Deutsch, or Français**. Selection previews immediately; **Save settings** remembers the language for the next launch. Closing settings or pressing **Esc** restores the previous language. The preference is shared across accounts and can be saved during generation without reconnecting the engine. It changes interface text and newly selected quick prompts, leaving existing conversations, account names, and unsent drafts intact.

The location-bar clock shows Tokyo time (JST). Chat timestamps and history date groups use your system time zone. The interface refreshes on system-clock second boundaries and synchronizes immediately when the window is restored; midnight appears as 00:00.

Models and reasoning levels retain the order, IDs, and supported ranges returned by the CLI. Common reasoning-level names are localized; unknown custom names remain unchanged. The client displays a confirmed selection only after the engine acknowledges it and the value is read back. It synchronizes again when restoring history. Unconfirmed selections are marked as pending confirmation.

The older CLI's third option, `grok-4`, appears as **Grok 4.3 (grok-4)**. In a Windows local check on 2026-09-07 with CLI 1.0.13, the selection and request ID were `grok-4`, while the actual reply's `usage.modelUsage` and saved `model_id` both reported `grok-4.3`. The client preserves the original request ID. Explicit names supplied by newer CLIs take priority, and a confirmed model in the current session's usage can also update the display. The [official model migration guide](https://docs.x.ai/developers/migration/may-15-retirement) provides background on the Grok 4 family's migration to 4.3.

Compatible older CLIs change reasoning levels through `_meta.reasoningEffort` on `session/set_model`, then load the session to read the setting back. CLIs supporting `session/set_config_option` use that interface. The client does not use `session/set_mode` to change reasoning levels.

**Allow subagents** passes `GROK_SUBAGENTS=1/0` to the CLI and restarts the account's engine after saving. Permissions, sandboxing, and MCP follow the official configuration precedence; the client does not rewrite the official `config.toml`. Reconnect after changing the official configuration.

**Tokyo Midnight Radio** plays the bundled original synthesizer instrumental *Tokyo Afterimage · 東京残像*: an 80 BPM, 96-second loop that works offline. It is enabled by default at 90% volume. If playback has not started after launch, click the window or press a key. Rain, music, and volume changes preview immediately; saving remembers them, while closing settings restores the previous values. Ambience preferences can be saved during generation without restarting the engine. Rain animation stops when your system enables reduced motion.

## Local data and repository contents

The data root on Windows is the source checkout, or the folder containing the packaged `App` directory. On Mac, both source and packaged runs use **`~/Library/Application Support/Grokbuild Tokyo`**. Thus `data` below means `~/Library/Application Support/Grokbuild Tokyo/data` on Mac, and `Workspace` is its sibling. Accounts, attachments, settings, and browser cache stay outside the Mac `.app`, so replacing or moving the app does not replace personal data. The local CLI account may also use `GROK_HOME` (default `~/.grok`).

| Path | Purpose | Tracked in Git |
| --- | --- | --- |
| `src` | Main process, ACP adapter, account management, and interface | Yes |
| `scripts`, `tests` | Packaging, regression tests, and isolated mock engines | Yes |
| `licenses` | Third-party license texts distributed with the source | Yes |
| `data` | Authentication, client chat history, settings, and browser cache | No |
| `Workspace` | Default project working directory | No |
| `App`, `dist` | Local app builds and distribution archives | No |
| `work` | Test data, screenshots, and development backups | No |
| `node_modules` | Installed development dependencies | No |

`data` contains personal information and should be backed up separately when migrating or backing up the client. A fresh clone does not include the developer's accounts, conversations, or configuration. The renderer uses isolation, sandboxing, and limited IPC; local image reads are restricted to the current session's allowed directories.

## Validation and development

```powershell
npm test
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
```

`npm audit --audit-level=moderate` checks known dependency advisories in the registry; it does not replace code or runtime security checks. Security regressions cover malicious reply HTML, private-network requests, permission-request reuse, file-read races, shutdown retries, and package contents.

Unit tests cover ACP, models and configuration, session persistence, image paths, account isolation, login lifecycle, name validation, account deletion and recovery, plus translation completeness, interpolation, and default-language handling across seven languages. UI tests exercise the real Electron main process, IPC, and interface with isolated mock CLI and login engines. They do not call real models or change everyday accounts.

Account UI tests cover adding, signing in, renaming, deletion confirmation, automatic switching, restart recovery, and the 980 × 680 layout. Language UI tests cover all seven languages: immediate preview, save and cancel, restart persistence, accessibility labels, dynamic status, preserved conversations and drafts, changes during generation, and compact-window layouts. GitHub Actions runs these checks on its configured Windows and Mac runners and validates packaged functionality. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the shared checks and Mac universal release checks.

Additional checks: `node scripts/packaged-launch-smoke.cjs` starts the shipped executable with isolated mock data; `node scripts/packaged-smoke.cjs` verifies the general packaged interface; `node scripts/ambience-smoke.cjs` verifies music and rain and also accepts `--packaged`.

Real CLI checks are separate: run `node scripts/config-smoke.cjs` explicitly. Live model tests include `node scripts/ui-smoke.cjs --live`, `node tests/live-smoke.cjs` with `GROK_LIVE_TEST=1` (optionally adding `--permission`), and `node tests/live-config-smoke.cjs` with `GROK_CONFIG_LIVE_TEST=1`. These are outside the default tests and use your local login and account usage.

### Grok compatibility

The historical live compatibility baseline is locally installed Grok Build **1.0.13 / ACP 1**, checked on Windows on 2026-09-07. Mac uses the same ACP implementation, but mock UI and package checks do not establish live model validation on Mac. Chat, session restoration, model/reasoning selection, tool execution, permission requests, and subagents run through the official CLI. The CLI handles file access, terminals, MCP, Skills, plugins, and sandboxing according to its own configuration; the desktop client does not take over file or terminal execution. Whether a permission prompt appears depends on the official permission mode, rules, and saved grants.

This CLI version advertises `image: false` and `audio: false` over ACP. Images and files are passed to CLI tools through baseline `resource_link` content with accurate local paths; the client does not claim unread files have been embedded. Replies still support image previews and saving attachments. The client does not provide dedicated controls for every `x.ai/*` extension or TUI-specific command, including Git/worktree management, session branching/rewind, interactive terminals, or slash-command menus. It therefore does not cover every feature of the official TUI. Incompatible protocols and engines that cannot restore history produce explicit notices.

The backdrop is a generated image of a rainy Shibuya night; its prompt is in [IMAGE-PROMPT.md](../src/renderer/assets/IMAGE-PROMPT.md). The icon is drawn by `scripts/make-icon.py` (requires Python and Pillow). Regenerate the background music from `scripts/ambient-score.js` with `node scripts/render-ambience.cjs`.

## Protocol and official references

- [Grok Build](https://github.com/xai-org/grok-build)
- [Grok authentication](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md)
- [Grok configuration](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/05-configuration.md)
- [Grok subagents](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md)
- [ACP content protocol](https://agentclientprotocol.com/protocol/v1/content)
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
