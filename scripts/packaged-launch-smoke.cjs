'use strict';

// Launch the delivered binary itself. A nonexistent CLI and an isolated profile
// make this startup check offline, with no access to a real account or prompts.
const { chromium } = require('playwright');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
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
  // Verify that release fuses ignore these attempts to enter Node mode, preload
  // code, or open a main-process inspector. Renderer CDP requires none of them.
  env.ELECTRON_RUN_AS_NODE = '1';
  env.NODE_OPTIONS = '--require=' + path.join(testRoot, 'must-not-load.cjs');
  const launchedAt = Date.now();
  const child = spawn(packagedExecutable(root), ['--mute-audio', '--inspect=0', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', browser;
  child.stdout.resume();
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Packaged Chromium startup timed out: ' + stderr)), 30000);
      function finish(error, value) {
        clearTimeout(timer);
        child.off('error', onError); child.off('exit', onExit);
        error ? reject(error) : resolve(value);
      }
      const onError = error => finish(error);
      const onExit = code => finish(new Error(`Packaged app exited (${code}): ${stderr}`));
      child.once('error', onError); child.once('exit', onExit);
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk.toString()).slice(-32768);
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) finish(null, match[1]);
      });
    });
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page');
    await page.waitForURL(pathToFileURL(path.join(packagedArchive(root), 'src', 'renderer', 'index.html')).href);
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
    const details = { appPath: packagedArchive(root), url: page.url(), platform: process.platform, windows: context.pages().length };
    assert.equal(details.windows, 1);
    assert.equal(fs.existsSync(path.join(testRoot, 'data', 'browser')), true, 'isolated browser profile was created');
    assert.doesNotMatch(stderr, /Debugger listening on/, 'main-process inspector fuse must stay disabled');
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
      await page.locator('#prompt').fill('Draft survives new-conversation shortcut');
      await page.keyboard.press('Meta+n');
      assert.equal(await page.locator('#prompt').inputValue(), 'Draft survives new-conversation shortcut');
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(testRoot, 'results.json'), JSON.stringify({ isolated: true, autoplay, details, errors }, null, 2));
    console.log(`PASS actual packaged ${process.platform}/${process.arch} binary: automatic music before interaction, isolated profile, renderer, shortcuts and release fuses ${JSON.stringify(autoplay)}`);
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGTERM');
      let timer;
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); })]);
      clearTimeout(timer);
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
