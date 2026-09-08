'use strict';

// Exercise production Electron, preload, IPC, history and audio using isolated
// profiles and a manually gated fake CLI. No personal state or paid requests.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createI18n } = require('../src/i18n.js');
const root = path.resolve(__dirname, '..');
const base = path.join(root, 'work', 'startup-qa');
fs.mkdirSync(base, { recursive: true });
const output = fs.mkdtempSync(path.join(base, 'run-'));
const results = [], errors = [];
const text = (language, source) => createI18n(language)(source);

async function launch(name, { history = true, hold = 'start', musicEnabled = false } = {}) {
  const profile = path.join(output, name);
  const workspace = path.join(profile, 'Workspace');
  const executable = path.join(profile, process.platform === 'win32' ? 'grok.exe' : 'grok');
  const file = path.join(profile, 'data', 'conversations.json');
  fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(executable, 'Fixture only; never executed.'); fs.chmodSync(executable, 0o755);
  const session = (id, title, offset) => ({ id, title, cwd: workspace, ...(id === 'recent' ? { model: 'grok-4.6', mode: 'medium' } : {}), createdAt: Date.now() - offset, updatedAt: Date.now() - offset, messages: [
    { id: `${id}-message`, role: 'user', text: `${title} — saved content`, createdAt: new Date().toISOString(), status: 'complete' },
  ] });
  fs.writeFileSync(file, JSON.stringify({ version: 1, settings: { executable, workspace, language: 'ja', rainEnabled: false, musicEnabled, musicVolume: 31 }, sessions: history ? [
    session('recent', 'Recent history', 0), session('older', 'Older history', 60000),
  ] : [] }));
  const env = { ...process.env, TOKYO_TEST_ROOT: profile, TOKYO_TEST_HOLD: hold };
  if (process.argv.includes('--packaged')) env.TOKYO_UI_SOURCE_ROOT = require('../scripts/package-paths.cjs').packagedArchive(root);
  delete env.ELECTRON_RUN_AS_NODE;
  const launchedAt = Date.now();
  const desktop = await _electron.launch({ args: [path.join(__dirname, 'fixtures', 'ui-app.cjs')], env });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setAudioMuted(true));
  const readState = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const gate = async method => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await desktop.evaluate((_, method) => globalThis.__tokyoUITest.gates.get(method)?.entered === true, method)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`${method} did not reach its fixture gate`);
  };
  const release = (method, error) => desktop.evaluate((_, args) => globalThis.__tokyoUITest.release(args.method, args.error), { method, error });
  const calls = () => desktop.evaluate(() => globalThis.__tokyoUITest.calls);
  const localReady = () => page.waitForFunction(() => document.documentElement.lang === 'ja' && !document.querySelector('#settings-button')?.disabled);
  const engineReady = () => page.waitForFunction(() => !document.querySelector('#connection-button')?.disabled);
  const openSettings = async () => { await page.locator('#settings-button').click(); await page.locator('#settings-dialog').waitFor({ state: 'visible' }); };
  const closeSettings = async () => { await page.locator('[data-close-dialog="settings-dialog"]').click(); await page.locator('#settings-dialog').waitFor({ state: 'hidden' }); };
  const saveSettings = async () => { await page.locator('#save-settings-button').click(); await page.locator('#settings-dialog').waitFor({ state: 'hidden' }); };
  const timed = async label => {
    const timing = await page.evaluate(() => ({ rendererMs: Math.round(performance.now()), language: document.documentElement.lang, music: document.querySelector('#music-status').dataset.state }));
    const entry = { name, stage: label, launchMs: Date.now() - launchedAt, ...timing };
    results.push(entry); console.log(`PASS ${name}: ${label} ${JSON.stringify(timing)}`);
  };
  return { name, profile, desktop, page, readState, gate, release, calls, localReady, engineReady, openSettings, closeSettings, saveSettings, timed };
}

async function run(name, options, action) {
  const test = await launch(name, options);
  try { await action(test); }
  catch (error) { console.error(`${name}: ${error.stack || error}`); await test.page.screenshot({ path: path.join(test.profile, 'failure.png'), animations: 'disabled' }).catch(() => {}); throw error; }
  finally {
    // Controller shutdown correctly waits for pending operations. Release test
    // gates even on assertions so a useful failure never hangs the test runner.
    await test.desktop.evaluate(() => {
      const fixture = globalThis.__tokyoUITest;
      for (const method of [...fixture.gates.keys()]) fixture.release(method);
    }).catch(() => {});
    await test.desktop.close();
  }
}

async function assertEngineBlocked(page) {
  for (const selector of ['#send-button', '#model-select', '#mode-select', '#workspace-button', '#attach-button', '#connection-button']) {
    assert.equal(await page.locator(selector).isDisabled(), true, `${selector} must wait for engine bootstrap to finish`);
  }
  assert.equal(await page.locator('#settings-button').isEnabled(), true);
  assert.equal(await page.locator('#prompt').isEnabled(), true);
}

(async () => {
  await run('saved-history', { hold: 'start,loadSession', musicEnabled: true }, async test => {
    const { page, desktop, gate, release, readState, openSettings, closeSettings, saveSettings } = test;
    await gate('start'); await test.localReady();
    assert.equal(await page.locator('#rain-layer').evaluate(element => element.hidden), true);
    assert.equal(await page.locator('.session-select').count(), 2);
    await test.timed('saved language, rain and local UI restored while CLI start is blocked');
    await assertEngineBlocked(page);
    await page.locator('#account-button').click();
    await page.locator('#accounts-dialog').waitFor({ state: 'visible' });
    for (const selector of ['#account-login', '#add-account-button', '[data-account-action="rename"]', '[data-account-action="switch"]']) {
      assert.equal(await page.locator(selector).first().isDisabled(), true, 'local account details remain readable while mutations wait for the engine');
    }
    await page.locator('#accounts-dialog [data-close-dialog]').click();
    const newDraft = 'Draft prepared before the CLI is ready';
    const historyDraft = 'Draft for the older saved conversation';
    await page.locator('#prompt').fill(newDraft);
    await page.locator('.session-select[title="Older history"]').click();
    assert.equal(await page.locator('.message.user .message-body').textContent(), 'Older history — saved content');
    await page.locator('#prompt').fill(historyDraft);
    assert.equal((await test.calls()).filter(item => item.method === 'loadSession').length, 0, 'local history does not wait on the engine');
    await openSettings();
    assert.equal(await page.locator('#language-select').inputValue(), 'ja');
    assert.equal(await page.locator('#rain-input').isChecked(), false);
    assert.equal(await page.locator('#music-input').isChecked(), true);
    assert.equal(await page.locator('#music-volume').inputValue(), '31');
    await page.waitForFunction(() => document.querySelector('#music-status').dataset.state === 'playing');
    await test.timed('music plays after interaction while CLI start is still blocked');
    await page.locator('#language-select').selectOption('fr');
    await page.locator('#music-volume').fill('47');
    await saveSettings();
    assert.equal(readState().settings.language, 'fr');
    assert.equal(readState().settings.musicVolume, 47);
    assert.equal((await test.calls()).filter(item => item.method === 'start').length, 1, 'presentation changes do not restart the pending engine');
    await assertEngineBlocked(page);
    await test.timed('preferences and history drafts remain editable before engine startup completes');

    await release('start'); await gate('loadSession');
    await assertEngineBlocked(page);
    await openSettings();
    await page.locator('#language-select').selectOption('ko');
    await page.locator('#music-volume').fill('52');
    await release('loadSession'); await test.engineReady();
    assert.equal(await page.locator('html').getAttribute('lang'), 'ko', 'bootstrap must preserve an open language preview');
    assert.equal(await page.locator('#music-volume').inputValue(), '52', 'bootstrap must preserve the open settings draft');
    assert.equal(readState().settings.language, 'fr', 'preview is not persisted');
    await closeSettings();
    await page.waitForFunction(() => document.documentElement.lang === 'fr');
    assert.equal(await page.locator('.session-item.active .session-title').textContent(), 'Older history');
    assert.equal(await page.locator('#prompt').inputValue(), historyDraft);
    await page.waitForFunction(() => !document.querySelector('#send-button').disabled && !document.querySelector('#model-select').disabled);
    await page.locator('#new-session').click();
    assert.equal(await page.locator('#prompt').inputValue(), newDraft);
    await page.locator('.session-select[title="Older history"]').click();
    assert.equal(await page.locator('#prompt').inputValue(), historyDraft);
    await page.locator('#send-button').click();
    await page.waitForFunction(() => document.querySelector('#stop-button').hidden && !document.querySelector('#settings-button').disabled);
    assert.equal((await test.calls()).filter(item => item.method === 'prompt').at(-1).text, historyDraft);
    assert.equal((await test.calls()).filter(item => item.method === 'loadSession').at(-1).sessionId, 'older');
    await test.timed('bootstrap preserves settings preview, history selection and drafts; send works once ready');
  });

  await run('empty-history', { history: false, hold: 'newSession' }, async test => {
    const { page, gate, release } = test;
    await gate('newSession'); await test.localReady();
    await assertEngineBlocked(page);
    assert.equal(await page.locator('.session-select').count(), 0);
    await page.locator('#prompt').fill('An early first conversation draft');
    await test.openSettings();
    await page.locator('#language-select').selectOption('de');
    await test.saveSettings();
    assert.equal(test.readState().settings.language, 'de');
    await test.timed('empty-profile UI usable while initial session creation is blocked');
    await release('newSession'); await test.engineReady();
    assert.equal(await page.locator('html').getAttribute('lang'), 'de');
    assert.equal(await page.locator('#prompt').inputValue(), 'An early first conversation draft');
    await page.locator('#send-button').click();
    await page.waitForFunction(() => document.querySelector('#stop-button').hidden && !document.querySelector('#settings-button').disabled);
    assert.equal((await test.calls()).filter(item => item.method === 'prompt').at(-1).text, 'An early first conversation draft');
    await test.timed('first-conversation draft and saved preferences survive session creation');
  });

  await run('failed-start', { hold: 'start' }, async test => {
    const { page, gate, release } = test;
    await gate('start'); await test.localReady();
    await page.locator('.session-select[title="Older history"]').click();
    await page.locator('#prompt').fill('Keep this draft after a failed connection');
    await release('start', 'Fixture startup failure'); await test.engineReady();
    assert.equal(await page.locator('#connection-label').textContent(), text('ja', '引擎未连接'));
    assert.equal(await page.locator('#settings-button').isEnabled(), true);
    assert.equal(await page.locator('#send-button').isDisabled(), true);
    assert.equal(await page.locator('#prompt').inputValue(), 'Keep this draft after a failed connection');
    assert.equal(await page.locator('.message.user .message-body').textContent(), 'Older history — saved content');
    await test.openSettings();
    await page.locator('#language-select').selectOption('en'); await test.saveSettings();
    assert.equal(test.readState().settings.language, 'en');
    await page.locator('.session-select[title="Recent history"]').click();
    assert.equal(await page.locator('.message.user .message-body').textContent(), 'Recent history — saved content');
    assert.equal(await page.locator('#rain-layer').evaluate(element => element.hidden), true);
    assert.equal(await page.locator('#music-status').getAttribute('data-state'), 'paused');
    await test.timed('failed startup retains saved language, settings, history and editable drafts');
  });
  assert.deepEqual(errors, []);
})().catch(error => { errors.push(error.stack || String(error)); console.error(error); process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ isolated: true, packagedResources: process.argv.includes('--packaged'), realGenerations: 0, results, errors }, null, 2));
  console.log(JSON.stringify({ passed: results.length, failed: errors.length, output }));
});
