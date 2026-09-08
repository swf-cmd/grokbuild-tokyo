'use strict';

// Launch the delivered binary itself. A nonexistent CLI and an isolated profile
// make this startup check offline, with no access to a real account or prompts.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { packagedExecutable, packagedArchive } = require('./package-paths.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work', 'packaged-launch'), { recursive: true });
const testRoot = fs.mkdtempSync(path.join(root, 'work', 'packaged-launch', 'run-'));
const workspace = path.join(testRoot, 'Workspace');
const executable = path.join(testRoot, 'missing-cli');
fs.mkdirSync(path.join(testRoot, 'data'));
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(testRoot, 'data', 'conversations.json'), JSON.stringify({ version: 1, sessions: [], settings: { executable, workspace, language: 'en', musicEnabled: true, musicVolume: 31 } }));

(async () => {
  const env = { ...process.env, TOKYO_TEST_ROOT: testRoot, GROK_HOME: path.join(testRoot, 'grok-home') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'TOKYO_UI_SOURCE_ROOT', 'GROK_AUTH', 'GROK_AUTH_PATH', 'XAI_API_KEY', 'GROK_CODE_XAI_API_KEY']) delete env[key];
  const launchedAt = Date.now();
  // Mute at process launch so verification never sends music to the speakers.
  const desktop = await _electron.launch({ executablePath: packagedExecutable(root), args: ['--mute-audio'], env });
  try {
    const page = await desktop.firstWindow();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const cdp = await page.context().newCDPSession(page);
    const deadline = Date.now() + 10000;
    let autoplay;
    do {
      // Ordinary Playwright evaluate() supplies a user gesture. This read must
      // never do so, otherwise the check could hide a click-to-play regression.
      const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({ rendererMs: Math.round(performance.now()),
          music: document.querySelector('#music-status')?.dataset.state,
          localReady: Boolean(document.querySelector('#settings-button')) && !document.querySelector('#settings-button').disabled,
          userActivated: navigator.userActivation.hasBeenActive })`,
        userGesture: false, returnByValue: true,
      });
      assert.equal(exceptionDetails, undefined);
      autoplay = JSON.parse(result.value);
      assert.equal(autoplay.userActivated, false, 'the delivered app must play before any interaction');
      if (autoplay.localReady && autoplay.music === 'playing') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.equal(autoplay.localReady, true);
    assert.equal(autoplay.music, 'playing');
    autoplay.launchMs = Date.now() - launchedAt;
    const details = await desktop.evaluate(({ app, BrowserWindow }) => ({
      packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData'),
      platform: process.platform, windows: BrowserWindow.getAllWindows().length,
    }));
    assert.equal(details.packaged, true);
    assert.equal(details.appPath, packagedArchive(root));
    assert.equal(details.userData, path.join(testRoot, 'data', 'browser'));
    assert.equal(details.windows, 1);
    assert.equal(await page.evaluate(() => window.tokyo.platform), process.platform);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(testRoot, 'packaged-welcome.png') });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
    await page.locator('#settings-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#executable-input').inputValue(), executable);
    await page.locator('[data-close-dialog="settings-dialog"]').click();
    if (process.platform === 'darwin') {
      assert.equal(await page.locator('.window-controls').isVisible(), false);
      assert.match(await page.locator('#new-session kbd').textContent(), /⌘/);
      assert.equal(await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('preferences').accelerator), 'Cmd+,');
      await page.locator('#prompt').fill('Draft survives closing the Mac window');
      // Playwright's CDP key events do not dispatch Cocoa menu accelerators.
      // Exercise the native window-close event, shared by the traffic light and Cmd+W.
      await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
      assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
      await desktop.evaluate(({ app }) => { app.emit('activate'); });
      assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
      assert.equal(await page.locator('#prompt').inputValue(), 'Draft survives closing the Mac window');
      await page.keyboard.press('Meta+n');
      // Already on an unsent new chat: the shared Windows/Mac behavior keeps
      // its draft. Also invoke the actual native menu to exercise its IPC route.
      await page.evaluate(() => window.tokyo.onMenuAction(action => { window.__lastMenuAction = action; }));
      await desktop.evaluate(({ Menu }) => { Menu.getApplicationMenu().getMenuItemById('new-conversation').click(); });
      await page.waitForFunction(() => window.__lastMenuAction === 'new-conversation');
      assert.equal(await page.locator('#prompt').inputValue(), 'Draft survives closing the Mac window');
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(testRoot, 'results.json'), JSON.stringify({ isolated: true, autoplay, details, errors }, null, 2));
    console.log(`PASS actual packaged ${process.platform}/${process.arch} binary: automatic music before interaction, isolated profile, renderer, shortcuts and lifecycle ${JSON.stringify(autoplay)}`);
  } finally { await desktop.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
