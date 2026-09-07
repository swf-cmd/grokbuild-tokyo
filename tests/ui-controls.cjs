'use strict';

// No real CLI is launched and no prompts, permissions, or links leave this fixture.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const base = path.join(root, 'work', 'ui-controls');
fs.mkdirSync(base, { recursive: true });
const testRoot = fs.mkdtempSync(path.join(base, 'run-'));
const workspace = path.join(testRoot, 'Workspace');
const alternateWorkspace = path.join(testRoot, 'Alternate');
const executable = path.join(testRoot, 'grok.exe');
const alternateExecutable = path.join(testRoot, 'alternate-grok.exe');
for (const folder of [workspace, alternateWorkspace, path.join(testRoot, 'data')]) fs.mkdirSync(folder, { recursive: true });
for (const file of [executable, alternateExecutable]) fs.writeFileSync(file, 'Test fixture only; never executed.');
fs.writeFileSync(path.join(testRoot, 'data', 'conversations.json'), JSON.stringify({ version: 1, settings: { executable, workspace, rainEnabled: true, subagentsEnabled: true }, sessions: [] }));
const readState = () => JSON.parse(fs.readFileSync(path.join(testRoot, 'data', 'conversations.json'), 'utf8'));

(async () => {
  const env = { ...process.env, TOKYO_TEST_ROOT: testRoot };
  // Load the real packaged resources with the test engine, without extraction.
  if (process.argv.includes('--packaged')) env.TOKYO_UI_SOURCE_ROOT = path.join(root, 'App', 'resources', 'app.asar');
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await _electron.launch({ args: [path.join(__dirname, 'fixtures', 'ui-app.cjs')], env });
  const page = await desktop.firstWindow();
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setAudioMuted(true));
  page.setDefaultTimeout(10000);
  const errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  const stage = async (name, callback) => {
    try { await callback(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
    catch (error) {
      results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`);
      await page.screenshot({ path: path.join(testRoot, `failure-${results.length}.png`), animations: 'disabled' }).catch(() => {});
      await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close())).catch(() => {});
      await desktop.evaluate(() => { globalThis.__tokyoUITest.dialogs = []; }).catch(() => {});
    }
  };
  const ready = () => page.waitForFunction(() => document.querySelector('#connection-label')?.textContent.includes('已连接') && !document.querySelector('#settings-button').disabled);
  const idle = () => page.waitForFunction(() => document.querySelector('#stop-button').hidden && !document.querySelector('#settings-button').disabled);
  const select = async (id, value) => { await page.locator(id).selectOption(value); await page.waitForFunction(({ id, value }) => document.querySelector(id).value === value && !document.querySelector('#model-select').disabled, { id, value }); };
  const queueDialog = result => desktop.evaluate((_electron, result) => globalThis.__tokyoUITest.dialogs.push(result), result);
  const calls = method => desktop.evaluate((_electron, method) => globalThis.__tokyoUITest.calls.filter(item => item.method === method), method);
  const openMenu = async () => { await page.locator('.session-item.active').hover(); await page.locator('.session-item.active .session-more').click(); await page.locator('#session-menu').waitFor({ state: 'visible' }); };
  const send = async text => { await page.locator('#prompt').fill(text); await page.locator('#send-button').click(); await idle(); };
  try {
    await ready();
    await stage('boot: explicit choices, safe bridge, empty composer', async () => {
      assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
      assert.equal(await page.evaluate(() => typeof window.tokyo.send), 'function');
      assert.equal(await page.locator('#model-select').inputValue(), 'grok-4.6');
      assert.equal(await page.locator('#mode-select').inputValue(), 'medium');
      assert.equal(await page.locator('option').filter({ hasText: '官方默认' }).count(), 0);
      assert.equal(await page.locator('#send-button').isDisabled(), true);
      assert.equal(await page.locator('#export-button').isDisabled(), true);
    });
    await stage('all starter cards, Shift+Enter, IME Enter', async () => {
      for (const card of await page.locator('[data-prompt]').all()) {
        await card.click(); assert.equal(await page.locator('#prompt').inputValue(), await card.getAttribute('data-prompt'));
      }
      await page.locator('#prompt').fill('first line'); await page.locator('#prompt').press('End'); await page.locator('#prompt').press('Shift+Enter');
      assert.equal(await page.locator('#prompt').inputValue(), 'first line\n');
      const count = (await calls('prompt')).length;
      await page.locator('#prompt').dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
      assert.equal((await calls('prompt')).length, count);
    });
    await stage('new-chat model and every effort are explicit and sent', async () => {
      await page.locator('#new-session').click();
      for (const effort of ['low', 'medium', 'high', 'xhigh']) await select('#mode-select', effort);
      await select('#model-select', 'grok-4.5'); assert.equal(await page.locator('#mode-select option[value="xhigh"]').count(), 0);
      await select('#model-select', 'grok-4'); assert.equal(await page.locator('#mode-select').isDisabled(), true);
      await select('#model-select', 'grok-4.6'); await select('#mode-select', 'high');
      await send('Initial UI fixture prompt');
      const created = (await calls('newSession')).at(-1); assert.equal(created.model, 'grok-4.6'); assert.equal(created.mode, 'high');
      assert.ok(readState().sessions[0].messages.some(message => message.text.includes('Fixture reply')));
    });
    await stage('existing-chat model and all effort changes persist', async () => {
      for (const effort of ['low', 'medium', 'high', 'xhigh']) { await select('#mode-select', effort); assert.equal(readState().sessions[0].mode, effort); }
      for (const model of ['grok-4.5', 'grok-4', 'grok-4.6']) { await select('#model-select', model); assert.equal(readState().sessions[0].model, model); }
      await desktop.evaluate(() => { globalThis.__tokyoUITest.failModel = true; });
      await page.locator('#model-select').selectOption('grok-4.5');
      await page.locator('.toast').filter({ hasText: 'model update rejected' }).waitFor();
      assert.equal(await page.locator('#model-select').inputValue(), 'grok-4.6');
      assert.equal(await page.locator('#model-select').isDisabled(), false);
    });
    await stage('reasoning/tool disclosures, sanitized Markdown, copy and links', async () => {
      await page.locator('.thought-details summary').first().click(); assert.equal(await page.locator('.thought-details').first().getAttribute('open'), '');
      await page.locator('.tool-entry summary').first().click(); assert.equal(await page.locator('.tool-entry').first().getAttribute('open'), '');
      assert.equal(await page.evaluate(() => window.__unsafe), undefined); assert.equal(await page.locator('#messages script').count(), 0);
      const previous = await desktop.evaluate(({ clipboard }) => clipboard.readText());
      try { await page.locator('.copy-code').first().click(); await page.locator('.copy-code').first().filter({ hasText: '已复制' }).waitFor(); assert.match(await desktop.evaluate(({ clipboard }) => clipboard.readText()), /console.log\("Tokyo"\)/); }
      finally { await desktop.evaluate(({ clipboard }, value) => clipboard.writeText(value), previous); }
      await page.locator('.message-body a').first().click(); assert.deepEqual(await desktop.evaluate(() => globalThis.__tokyoUITest.external), ['https://example.com/test']);
    });
    await stage('topbar and menu export write Markdown; chooser cancel is harmless', async () => {
      await queueDialog({ canceled: true }); await page.locator('#export-button').click();
      const file = path.join(testRoot, 'topbar-export.md'); await queueDialog({ canceled: false, filePath: file }); await page.locator('#export-button').click();
      await page.waitForFunction(() => document.querySelector('#toast-container').textContent.includes('topbar-export.md'));
      assert.match(fs.readFileSync(file, 'utf8'), /Initial UI fixture prompt/);
      const menuFile = path.join(testRoot, 'menu-export.md'); await queueDialog({ canceled: false, filePath: menuFile }); await openMenu(); await page.locator('#menu-export').click();
      await page.waitForFunction(() => document.querySelector('#toast-container').textContent.includes('menu-export.md'));
      assert.match(fs.readFileSync(menuFile, 'utf8'), /Fixture reply/);
    });
    await stage('rename save/cancel, search toggle/filter/Escape, per-chat drafts', async () => {
      await openMenu(); await page.locator('#menu-rename').click(); await page.locator('#rename-input').fill('Renamed fixture'); await page.locator('#rename-form button[type="submit"]').click();
      await page.locator('#rename-dialog').waitFor({ state: 'hidden' }); assert.equal(readState().sessions[0].title, 'Renamed fixture');
      await openMenu(); await page.locator('#menu-rename').click(); await page.locator('#rename-input').fill('Discarded'); await page.locator('#rename-dialog .secondary-button').click();
      assert.equal(readState().sessions[0].title, 'Renamed fixture');
      await page.locator('#search-toggle').click(); await page.locator('#session-search').fill('no-such-chat'); assert.equal(await page.locator('.session-select').count(), 0);
      await page.locator('#session-search').fill('Renamed'); assert.equal(await page.locator('.session-select').count(), 1);
      await page.locator('#session-search').press('Escape'); assert.equal(await page.locator('#history-search').isHidden(), true);
      await page.locator('#prompt').fill('Saved draft'); await page.keyboard.press('Control+n'); assert.equal(await page.locator('#prompt').inputValue(), '');
      await page.locator('#prompt').fill('New draft'); await page.locator('#new-session').click(); assert.equal(await page.locator('#prompt').inputValue(), 'New draft');
      await page.locator('.session-select').filter({ hasText: 'Renamed fixture' }).click(); await idle(); assert.equal(await page.locator('#prompt').inputValue(), 'Saved draft');
    });
    await stage('settings browser buttons, cancel, validation, persistence and reconnect', async () => {
      await page.keyboard.press('Control+,'); await page.locator('#settings-dialog').waitFor({ state: 'visible' });
      await queueDialog({ canceled: true, filePaths: [] }); await page.locator('#choose-executable').click(); assert.equal(await page.locator('#executable-input').inputValue(), executable);
      await queueDialog({ canceled: false, filePaths: [alternateExecutable] }); await page.locator('#choose-executable').click();
      await page.waitForFunction(expected => document.querySelector('#executable-input').value === expected, alternateExecutable);
      await queueDialog({ canceled: false, filePaths: [alternateWorkspace] }); await page.locator('#choose-workspace').click();
      await page.waitForFunction(expected => document.querySelector('#workspace-input').value === expected, alternateWorkspace);
      await page.locator('#rain-input').uncheck(); await page.locator('#subagents-input').uncheck();
      await page.locator('[data-close-dialog="settings-dialog"]').click(); assert.equal(readState().settings.workspace, workspace);
      await page.locator('#settings-button').click(); assert.equal(await page.locator('#rain-input').isChecked(), true);
      await page.locator('#executable-input').fill(''); await page.locator('#save-settings-button').click(); await page.locator('#settings-feedback').filter({ hasText: '请选择' }).waitFor();
      await page.locator('#executable-input').fill(alternateExecutable); await page.locator('#workspace-input').fill(alternateWorkspace); await page.locator('#rain-input').uncheck(); await page.locator('#subagents-input').uncheck();
      await page.locator('#save-settings-button').click(); await page.locator('#settings-dialog').waitFor({ state: 'hidden' }); await ready();
      assert.deepEqual(readState().settings, { executable: alternateExecutable, workspace: alternateWorkspace, rainEnabled: false, subagentsEnabled: false, musicEnabled: true, musicVolume: 90 });
      assert.equal(await page.locator('#rain-layer').isHidden(), true);
      assert.equal(await desktop.evaluate(() => globalThis.__tokyoUITest.adapter.options.subagentsEnabled), false);
      assert.equal(await page.locator('#session-path').textContent(), workspace, 'existing chat keeps its own directory');
    });
    await stage('settings and topbar reconnect, workspace button, rain on', async () => {
      let before = (await calls('start')).length; await page.locator('#connection-button').click(); await ready(); assert.equal((await calls('start')).length, before + 1);
      await page.locator('#settings-button').click(); before = (await calls('start')).length; await page.locator('#settings-reconnect').click(); await page.locator('#settings-dialog').waitFor({ state: 'hidden' }); await ready(); assert.equal((await calls('start')).length, before + 1);
      await page.locator('#settings-button').click();
      await page.locator('#rain-input').check(); await page.locator('#subagents-input').check(); await page.locator('#save-settings-button').click(); await page.locator('#settings-dialog').waitFor({ state: 'hidden' }); await ready();
      assert.equal(await page.locator('#rain-layer').isHidden(), false); assert.equal(await desktop.evaluate(() => globalThis.__tokyoUITest.adapter.options.subagentsEnabled), true);
      await queueDialog({ canceled: false, filePaths: [workspace] }); await page.locator('#workspace-button').click(); await ready();
      assert.equal(readState().settings.workspace, workspace);
    });
    await stage('Enter send, busy controls, stop generation, error recovery', async () => {
      await page.locator('#prompt').fill('WAIT for cancellation'); await page.locator('#prompt').press('Enter'); await page.locator('#stop-button').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#model-select').isDisabled(), true); assert.equal(await page.locator('#workspace-button').isDisabled(), true); assert.equal(await page.locator('#connection-button').isDisabled(), true);
      await page.locator('#stop-button').click(); await idle(); assert.equal(readState().sessions[0].messages.at(-1).status, 'cancelled');
      await desktop.evaluate(() => { globalThis.__tokyoUITest.failPrompt = true; }); await send('Error recovery fixture');
      await page.locator('.message-error').last().waitFor(); assert.equal(readState().sessions[0].messages.at(-1).status, 'error');
      await send('Recovered request'); assert.equal(readState().sessions[0].messages.at(-1).status, 'complete');
    });
    await stage('every permission option, failed permission retry, disabled duplicate submission', async () => {
      for (const [optionId, name] of [['allow-once', '允许一次'], ['allow-always', '始终允许'], ['reject-once', '拒绝一次'], ['reject-always', '始终拒绝']]) {
        await page.locator('#prompt').fill('PERMISSION ' + optionId); await page.locator('#send-button').click(); await page.locator('#permission-panel').waitFor({ state: 'visible' });
        if (optionId === 'allow-once') {
          await desktop.evaluate(() => { globalThis.__tokyoUITest.failPermission = true; }); await page.locator('#permission-panel').getByRole('button', { name, exact: true }).click();
          await page.locator('.toast').filter({ hasText: 'permission rejected' }).waitFor(); assert.equal(await page.locator('#permission-panel button').first().isDisabled(), false);
        }
        await page.locator('#permission-panel').getByRole('button', { name, exact: true }).click(); await idle();
        assert.equal((await calls('respondPermission')).at(-1).optionId, optionId); assert.equal(await page.locator('#permission-panel').isHidden(), true);
      }
    });
    await stage('queued permissions, external resolution, nonfatal errors keep stop available', async () => {
      await page.locator('#prompt').fill('WAIT queued permissions'); await page.locator('#send-button').click(); await page.locator('#stop-button').waitFor({ state: 'visible' });
      await desktop.evaluate(() => {
        const test = globalThis.__tokyoUITest; test.holdPermission = true;
        const sessionId = [...test.adapter.pending.keys()][0];
        for (const requestId of ['queue-first', 'queue-second']) test.adapter.emit('event', { type: 'permission', sessionId, requestId, title: requestId, options: [{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }] });
      });
      await page.locator('#permission-panel').filter({ hasText: 'queue-first' }).waitFor(); await page.locator('#permission-panel button').click();
      await page.locator('#permission-panel').filter({ hasText: 'queue-second' }).waitFor();
      await desktop.evaluate(() => { const test = globalThis.__tokyoUITest; const sessionId = [...test.adapter.pending.keys()][0]; test.adapter.emit('event', { type: 'status', status: 'permission_resolved', sessionId, requestId: 'queue-second' }); });
      await page.locator('#permission-panel').waitFor({ state: 'hidden' });
      await desktop.evaluate(() => { const test = globalThis.__tokyoUITest; const sessionId = [...test.adapter.pending.keys()][0]; test.adapter.emit('event', { type: 'error', sessionId, message: 'Recoverable fixture notification' }); });
      await page.locator('.toast').filter({ hasText: 'Recoverable fixture' }).waitFor(); assert.equal(await page.locator('#stop-button').isVisible(), true);
      await page.locator('#stop-button').click(); await idle(); await desktop.evaluate(() => { globalThis.__tokyoUITest.holdPermission = false; });
    });
    await stage('rain can save during generation; engine changes wait for stop', async () => {
      await page.locator('#prompt').fill('WAIT busy rain'); await page.locator('#send-button').click(); await page.locator('#stop-button').waitFor({ state: 'visible' });
      await page.locator('#settings-button').click(); await page.locator('#rain-input').uncheck(); await page.locator('#save-settings-button').click();
      await page.locator('#settings-dialog').waitFor({ state: 'hidden' }); assert.equal(readState().settings.rainEnabled, false); assert.equal(await page.locator('#stop-button').isVisible(), true);
      await page.locator('#settings-button').click(); await page.locator('#subagents-input').uncheck(); await page.locator('#save-settings-button').click();
      await page.locator('#settings-feedback').filter({ hasText: '停止' }).waitFor(); assert.equal(readState().settings.subagentsEnabled, true);
      await page.locator('[data-close-dialog="settings-dialog"]').click(); await page.locator('#stop-button').click(); await idle();
    });
    await stage('offline history stays readable and reconnect restores selections', async () => {
      await desktop.evaluate(() => globalThis.__tokyoUITest.adapter.emit('event', { type: 'status', status: 'disconnected' }));
      await page.locator('#connection-label').filter({ hasText: '未连接' }).waitFor();
      await page.locator('#new-session').click(); await page.locator('.session-select').filter({ hasText: 'Renamed fixture' }).click();
      await page.locator('#messages').waitFor({ state: 'visible' }); assert.equal(await page.locator('#model-select').isDisabled(), true); assert.equal(await page.locator('#send-button').isDisabled(), true);
      await page.locator('#connection-button').click(); await ready(); assert.equal(await page.locator('#model-select').isDisabled(), false);
    });
    await stage('scroll to latest, compact settings, window maximize/restore/minimize', async () => {
      await page.locator('#conversation-scroll').evaluate(element => { element.scrollTop = 0; }); await page.locator('#scroll-bottom').waitFor({ state: 'visible' }); await page.locator('#scroll-bottom').click();
      await page.waitForFunction(() => { const element = document.querySelector('#conversation-scroll'); return element.scrollHeight - element.scrollTop - element.clientHeight < 100; });
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680)); await page.locator('#settings-button').click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('#save-settings-button').evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }), true);
      await page.screenshot({ path: path.join(testRoot, 'compact-settings.png'), animations: 'disabled' }); await page.locator('[data-close-dialog="settings-dialog"]').click();
      await page.locator('[data-window="maximize"]').click(); await page.waitForTimeout(200); assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), true);
      await page.locator('[data-window="maximize"]').click(); await page.waitForTimeout(200); assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), false);
      await page.locator('[data-window="minimize"]').click(); await page.waitForTimeout(200); assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), true);
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
    });
    await stage('delete keep/close/confirm and disabled export after deletion', async () => {
      const before = readState().sessions.length;
      await openMenu(); await page.locator('#menu-delete').click(); await page.locator('#delete-dialog .secondary-button').click(); assert.equal(readState().sessions.length, before);
      await openMenu(); await page.locator('#menu-delete').click(); await page.locator('#delete-dialog .dialog-close').click(); assert.equal(readState().sessions.length, before);
      await openMenu(); await page.locator('#menu-delete').click(); await page.locator('#confirm-delete').click(); await page.locator('#delete-dialog').waitFor({ state: 'hidden' });
      assert.equal(readState().sessions.length, before - 1); assert.equal(await page.locator('#export-button').isDisabled(), true);
    });
    await stage('unknown model metadata loads confirmed choices without losing the draft', async () => {
      await page.locator('#prompt').fill('Preserved discovery draft');
      await select('#model-select', 'grok-discovered');
      assert.equal(await page.locator('#prompt').inputValue(), 'Preserved discovery draft');
      assert.equal(await page.locator('#mode-select').inputValue(), 'medium');
      assert.equal(await page.locator('#mode-select').isDisabled(), false);
      assert.equal(await page.locator('#mode-select option').count(), 3);
      assert.equal(readState().sessions[0].model, 'grok-discovered');
      await page.locator('#send-button').click(); await idle();
      assert.equal((await calls('prompt')).at(-1).text, 'Preserved discovery draft');
    });
    await stage('no renderer errors', async () => assert.deepEqual(errors, []));
    await page.screenshot({ path: path.join(testRoot, 'complete.png'), animations: 'disabled' });
    await stage('close window', async () => {
      await Promise.all([page.waitForEvent('close'), page.locator('[data-window="close"]').click()]);
    });
  } finally {
    await desktop.close().catch(() => {});
    fs.writeFileSync(path.join(testRoot, 'results.json'), JSON.stringify({ isolated: true, packagedResources: process.argv.includes('--packaged'), realGenerations: 0, results, errors }, null, 2));
    console.log(JSON.stringify({ isolated: true, packagedResources: process.argv.includes('--packaged'), realGenerations: 0, passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).length, output: testRoot }));
    if (results.some(item => !item.passed)) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
