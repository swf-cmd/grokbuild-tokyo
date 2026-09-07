'use strict';
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work/security-ui'), { recursive: true });
const testRoot = fs.mkdtempSync(path.join(root, 'work/security-ui/run-'));
const workspace = path.join(testRoot, 'Workspace');
const executable = path.join(testRoot, 'grok.exe');
fs.mkdirSync(workspace); fs.mkdirSync(path.join(testRoot, 'data'));
fs.writeFileSync(executable, 'Never executed: isolated fixture.');
fs.writeFileSync(path.join(testRoot, 'data/conversations.json'), JSON.stringify({ version: 1, settings: { executable, workspace, musicEnabled: false, language: 'en' }, sessions: [] }));

(async () => {
  const env = { ...process.env, TOKYO_TEST_ROOT: testRoot };
  if (process.argv.includes('--packaged')) env.TOKYO_UI_SOURCE_ROOT = path.join(root, 'App/resources/app.asar');
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await _electron.launch({ args: [path.join(__dirname, 'fixtures/ui-app.cjs')], env });
  try {
    const page = await desktop.firstWindow();
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => document.querySelector('#connection-label')?.textContent === 'Engine connected');
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => { window.__trustedPrompt = document.querySelector('#prompt'); });
    await page.locator('#prompt').fill('WAIT malicious reply fixture');
    await page.locator('#send-button').click();
    await page.waitForFunction(() => !document.querySelector('#stop-button').hidden);
    await desktop.evaluate(() => {
      const adapter = globalThis.__tokyoUITest.adapter;
      const sessionId = [...adapter.pending.keys()][0];
      adapter.emit('event', { type: 'text', sessionId, text: '<textarea id="prompt">attacker command</textarea>\n<div id="settings-dialog" class="titlebar window-close" data-window="close" data-i18n="Send">FORGED CONTROL</div>\n<script>window.__unsafe = true</script>\n<iframe src="https://evil.invalid/"></iframe><video src="https://evil.invalid/tracker"></video>\n<a href="javascript:alert(1)" onclick="window.__unsafe=true">bad link</a>\n<svg onload="window.__unsafe=true"></svg>\n\n**Safe formatting** and [a normal link](https://example.com/safe)\n\n<img src="https://127.0.0.1:9/private.png" alt="blocked private image" onerror="window.__unsafe=true">' });
    });
    await page.locator('.message-body').filter({ hasText: 'Safe formatting' }).waitFor();
    assert.equal(await page.evaluate(() => document.getElementById('prompt') === window.__trustedPrompt), true, 'reply must not replace the real composer');
    assert.equal(await page.locator('#prompt').count(), 1);
    assert.equal(await page.locator('.message-body [id], .message-body textarea, .message-body iframe, .message-body video, .message-body svg, .message-body script, .message-body .titlebar, .message-body [data-window]').count(), 0);
    assert.equal(await page.evaluate(() => window.__unsafe), undefined);
    assert.equal(await page.locator('.message-body strong').last().textContent(), 'Safe formatting');
    await page.locator('.chat-image .image-retry').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.chat-image img').getAttribute('src'), null);
    await page.getByRole('link', { name: 'a normal link', exact: true }).click();
    assert.deepEqual(await desktop.evaluate(() => globalThis.__tokyoUITest.external), ['https://example.com/safe']);
    for (const url of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:']) {
      assert.equal(await page.evaluate(async url => { try { await window.tokyo.openExternal(url); return 'allowed'; } catch { return 'blocked'; } }, url), 'blocked');
    }
    const preferences = await desktop.evaluate(({ BrowserWindow }) => {
      const settings = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { contextIsolation: settings.contextIsolation, sandbox: settings.sandbox, nodeIntegration: settings.nodeIntegration, webSecurity: settings.webSecurity };
    });
    assert.deepEqual(preferences, { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true });
    await page.locator('#stop-button').click();
    await page.waitForFunction(() => document.querySelector('#stop-button').hidden);
    await page.locator('#prompt').fill('trusted user message after hostile HTML');
    await page.locator('#send-button').click();
    await page.waitForFunction(() => document.querySelector('#stop-button').hidden);
    assert.equal(await desktop.evaluate(() => globalThis.__tokyoUITest.calls.filter(call => call.method === 'prompt').at(-1).text), 'trusted user message after hostile HTML');
    assert.deepEqual(errors, []);
    console.log('PASS hostile HTML, private-network image, external protocols, trusted composer and Electron isolation');

    await desktop.evaluate(({ dialog }) => {
      const test = globalThis.__tokyoUITest;
      test.shutdownCalls = 0; test.shutdownErrors = [];
      dialog.showErrorBox = (title, message) => test.shutdownErrors.push({ title, message });
      test.adapter.close = () => {
        test.shutdownCalls++;
        return new Promise((resolve, reject) => { test.releaseClose = resolve; test.rejectClose = reject; });
      };
    });
    await page.evaluate(() => window.tokyo.windowControl('close'));
    assert.equal(await desktop.evaluate(() => globalThis.__tokyoUITest.shutdownCalls), 1);
    const stillClosing = await desktop.evaluate(({ app, BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].close(); app.quit();
      return { windows: BrowserWindow.getAllWindows().length, closeCalls: globalThis.__tokyoUITest.shutdownCalls };
    });
    assert.deepEqual(stillClosing, { windows: 1, closeCalls: 1 }, 'repeated quit requests must wait for the existing shutdown');
    await desktop.evaluate(() => { globalThis.__tokyoUITest.rejectClose(new Error('UI fixture: process did not stop')); });
    const closeErrors = await desktop.evaluate(() => new Promise(resolve => setImmediate(() => resolve(globalThis.__tokyoUITest.shutdownErrors))));
    assert.equal(closeErrors.length, 1);
    assert.equal(closeErrors[0].message, 'UI fixture: process did not stop');
    assert.equal(page.isClosed(), false, 'failed shutdown must preserve a window for retry');
    await page.evaluate(() => window.tokyo.windowControl('close'));
    assert.equal(await desktop.evaluate(() => globalThis.__tokyoUITest.shutdownCalls), 2, 'a failed shutdown permits retry');
    const closed = page.waitForEvent('close');
    await desktop.evaluate(() => { setImmediate(() => globalThis.__tokyoUITest.releaseClose()); });
    await closed;
    console.log('PASS shutdown coalesces repeated close requests and preserves a retry after failure');
  } finally { await desktop.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
