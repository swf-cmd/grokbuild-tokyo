'use strict';

// Exercise a fresh, signed-out installation through production Electron and
// IPC. Only the CLI/device authorization transport is replaced by a fixture.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const base = path.join(root, 'work', 'onboarding-qa');
fs.mkdirSync(base, { recursive: true });
const output = fs.mkdtempSync(path.join(base, 'run-'));
const workspace = path.join(output, 'Workspace');
const executable = path.join(output, process.platform === 'win32' ? 'grok.exe' : 'grok');
const stateFile = path.join(output, 'data', 'conversations.json');
const authFile = path.join(output, 'default-grok', 'auth.json');
fs.mkdirSync(workspace); fs.mkdirSync(path.dirname(stateFile));
fs.writeFileSync(executable, 'Fixture only; never executed.'); fs.chmodSync(executable, 0o755);
fs.writeFileSync(stateFile, JSON.stringify({ version: 1, settings: { executable, workspace, language: 'zh-CN', rainEnabled: false, musicEnabled: false }, sessions: [] }));
const results = [], errors = [];
const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));

(async () => {
  const env = { ...process.env, TOKYO_TEST_ROOT: output, TOKYO_TEST_SIGNED_OUT: '1' };
  if (process.argv.includes('--packaged')) env.TOKYO_UI_SOURCE_ROOT = require('../scripts/package-paths.cjs').packagedArchive(root);
  delete env.ELECTRON_RUN_AS_NODE; delete env.TOKYO_TEST_HOLD;
  const desktop = await _electron.launch({ args: ['--mute-audio', path.join(__dirname, 'fixtures', 'ui-app.cjs')], env });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  const calls = () => desktop.evaluate(() => globalThis.__tokyoUITest.calls);
  const stage = async (name, action) => { await action(); results.push(name); console.log(`PASS ${name}`); };
  const closeAccounts = () => page.locator('[data-close-dialog="accounts-dialog"]').click();
  const loginChallenge = () => page.locator('#account-login-code').filter({ hasText: 'TEST-1234' }).waitFor();
  const draft = 'First conversation draft written before signing in';
  try {
    await stage('first launch explains sign-in and does not start the engine or show an error', async () => {
      await page.waitForFunction(() => !document.querySelector('#connection-button').disabled && !document.querySelector('#signin-button').disabled);
      assert.equal(fs.existsSync(authFile), false);
      assert.equal(await page.locator('#signin-notice').isVisible(), true);
      assert.equal(await page.locator('#account-status').textContent(), '尚未登录');
      assert.equal(await page.locator('#signin-settings').isEnabled(), true);
      assert.equal(await page.locator('#send-button').isDisabled(), true);
      assert.equal(await page.locator('#prompt').isEnabled(), true);
      assert.equal(await page.locator('#toast-container .toast.error').count(), 0);
      assert.equal((await calls()).filter(call => ['constructor', 'start', 'login'].includes(call.method)).length, 0, 'unsigned startup must not wait for an engine authentication timeout');
      assert.equal(await page.locator('.session-select').count(), 0);
      await page.locator('#prompt').fill(draft);
      await page.locator('#signin-settings').click();
      await page.locator('#settings-dialog').waitFor({ state: 'visible' });
      await page.locator('[data-close-dialog="settings-dialog"]').click();
      assert.equal(await page.locator('#prompt').inputValue(), draft);
      await page.locator('#account-button').click();
      assert.equal(await page.locator('#account-help').textContent(), '首次使用：点击下方按钮，在浏览器中登录 Grok，无需先添加账户。');
      assert.equal(await page.locator('.account-row').count(), 1);
      assert.match(await page.locator('.account-row[data-account-id="local"] .account-info').textContent(), /尚未登录/);
      assert.equal(await page.locator('#account-login').isEnabled(), true);
      await closeAccounts();
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
      await page.screenshot({ path: path.join(output, 'first-run-compact.png'), animations: 'disabled' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('#signin-button').evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }), true, 'the sign-in action remains visible at the minimum window size');
    });

    await stage('the first-run action signs in the default account and shows the browser challenge', async () => {
      await page.locator('#signin-button').click();
      await page.locator('#accounts-dialog').waitFor({ state: 'visible' });
      await loginChallenge();
      assert.equal(await page.locator('.account-row.selected').getAttribute('data-account-id'), 'local');
      assert.equal(await page.locator('.account-row').count(), 1, 'first-time login does not require or create an extra profile');
      assert.equal(await page.locator('#account-login-panel').isVisible(), true);
      assert.equal(await page.locator('#account-open-login').isEnabled(), true);
      assert.equal(await page.locator('#account-login').isDisabled(), true);
      assert.equal(await page.locator('#add-account-button').isDisabled(), true);
      await page.locator('#account-open-login').click();
      assert.equal(await desktop.evaluate(() => globalThis.__tokyoUITest.external.at(-1)), 'https://auth.x.ai/device');
      assert.equal((await calls()).filter(call => call.method === 'login').length, 1);
      assert.equal((await calls()).find(call => call.method === 'login').grokHome, path.join(output, 'default-grok'));
      await page.screenshot({ path: path.join(output, 'login-challenge-compact.png'), animations: 'disabled' });
      assert.equal(await page.locator('#accounts-dialog').evaluate(element => element.scrollWidth > element.clientWidth || element.getBoundingClientRect().bottom > innerHeight), false);
      await closeAccounts();
      assert.equal(await page.locator('#signin-notice').isVisible(), true);
      assert.equal(await page.locator('#prompt').inputValue(), draft);
      await page.locator('#signin-button').click();
      await loginChallenge();
      assert.equal((await calls()).filter(call => call.method === 'login').length, 1, 'returning to an in-progress sign-in must reuse the challenge');
    });

    await stage('cancelled and failed sign-ins return to a usable retry state', async () => {
      await page.locator('#account-cancel-login').click();
      await page.locator('#account-login-panel').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => !document.querySelector('#account-login').disabled);
      assert.match(await page.locator('#account-feedback').textContent(), /登录已取消/);
      assert.equal(await page.locator('#account-login-code').textContent(), '');
      assert.equal(fs.existsSync(authFile), false);
      await page.locator('#account-login').click(); await loginChallenge();
      await desktop.evaluate(() => globalThis.__tokyoUITest.finishLogin(false));
      await page.waitForFunction(() => document.querySelector('#account-feedback').textContent.includes('登录未完成') && !document.querySelector('#account-login').disabled);
      assert.equal(await page.locator('#account-login-panel').isHidden(), true);
      assert.equal(await page.locator('#account-login-code').textContent(), '');
      assert.equal(fs.existsSync(authFile), false);
      assert.equal((await calls()).filter(call => call.method === 'start').length, 0);
      await closeAccounts();
      assert.equal(await page.locator('#signin-notice').isVisible(), true);
      assert.equal(await page.locator('#account-status').textContent(), '尚未登录');
      assert.equal(await page.locator('#prompt').inputValue(), draft);
      assert.equal(await page.locator('#send-button').isDisabled(), true);
      await page.locator('#signin-button').click(); await loginChallenge();
    });

    await stage('successful sign-in connects automatically and preserves the first draft', async () => {
      await desktop.evaluate(() => globalThis.__tokyoUITest.finishLogin(true));
      await page.waitForFunction(() => document.querySelector('#connection-label').textContent.includes('已连接') && !document.querySelector('#account-login').disabled);
      assert.equal(fs.existsSync(authFile), true);
      assert.equal(await page.locator('#signin-notice').isHidden(), true);
      assert.equal(await page.locator('#account-status').textContent(), '账户切换');
      assert.match(await page.locator('#account-list').textContent(), /tokyo@example.test/);
      assert.equal(readState().accounts.length, 1);
      assert.equal(readState().activeAccountId, 'local');
      assert.equal((await calls()).filter(call => call.method === 'start').length, 1);
      await closeAccounts();
      assert.equal(await page.locator('#prompt').inputValue(), draft);
      assert.equal(await page.locator('#send-button').isEnabled(), true);
      await page.locator('#send-button').click();
      await page.waitForFunction(() => document.querySelector('#stop-button').hidden && !document.querySelector('#account-button').disabled);
      assert.equal((await calls()).filter(call => call.method === 'prompt').at(-1)?.text, draft);
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#connection-label').textContent.includes('已连接') && !document.querySelector('#account-button').disabled);
      assert.equal(await page.locator('#signin-notice').isHidden(), true, 'saved authentication bypasses onboarding after reload');
      assert.equal((await calls()).filter(call => call.method === 'login').length, 3);
    });
    assert.deepEqual(errors, []);
  } catch (error) {
    errors.push(error.stack || String(error));
    await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' }).catch(() => {});
    throw error;
  } finally {
    await desktop.close();
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ isolated: true, packagedResources: process.argv.includes('--packaged'), realGenerations: 0, results, errors }, null, 2));
    console.log(JSON.stringify({ passed: results.length, failed: errors.length, output }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
