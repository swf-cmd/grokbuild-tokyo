const { _electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { findGrokExecutable } = require('../src/platform.cjs');
const { packagedExecutable } = require('./package-paths.cjs');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const base = path.join(root, 'work', 'config-ui');
fs.mkdirSync(base, { recursive: true });
const testRoot = fs.mkdtempSync(path.join(base, 'run-'));
fs.mkdirSync(path.join(testRoot, 'data'));
fs.mkdirSync(path.join(testRoot, 'Workspace'));
fs.writeFileSync(path.join(testRoot, 'data', 'conversations.json'), JSON.stringify({ version: 1, sessions: [], settings: {
  executable: process.env.GROK_EXECUTABLE || findGrokExecutable({ home: os.homedir() }),
  workspace: path.join(testRoot, 'Workspace'), language: 'zh-CN', musicEnabled: false,
} }));
let stage = 'launch';

(async () => {
  const env = { ...process.env, TOKYO_TEST_ROOT: testRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.argv.includes('--packaged');
  const desktop = await _electron.launch(packaged
    ? { executablePath: packagedExecutable(root), args: ['--mute-audio'], env }
    : { args: [root, '--mute-audio'], env });
  try {
    const page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    stage = 'connect';
    await page.waitForFunction(() => document.querySelector('#connection-label').textContent.includes('已连接') && !document.querySelector('#settings-button').disabled, null, { timeout: 60000 });
    const readState = () => JSON.parse(fs.readFileSync(path.join(testRoot, 'data', 'conversations.json'), 'utf8'));
    const boot = await page.evaluate(() => window.tokyo.bootstrap());
    assert.equal(boot.connected, true);
    const initial = boot.sessions[0];
    assert.ok(initial, 'the engine creates a session without sending a prompt');
    const sessionId = initial.id;
    const readSession = () => {
      const session = readState().sessions.find(item => item.id === sessionId);
      assert.ok(session, 'the active session remains persisted');
      return session;
    };
    const assertChoices = async session => {
      assert.equal(session.modelSelectionVerified, true, 'the engine confirms the selected model and effort');
      assert.ok(session.models.some(model => model.id === session.model), 'the selected model belongs to the engine catalog');
      assert.deepEqual(await page.locator('#model-select option').evaluateAll(options => options.map(option => option.value)), session.models.map(model => model.id), 'model IDs and order match engine metadata');
      assert.equal(await page.locator('#model-select').inputValue(), session.model);
      const modes = session.modes || [];
      assert.deepEqual(await page.locator('#mode-select option').evaluateAll(options => options.map(option => option.value)), modes.length ? modes.map(mode => mode.id) : [''], 'effort IDs and order match engine metadata');
      assert.equal(await page.locator('#mode-select').inputValue(), session.mode || '');
      assert.equal(await page.locator('#mode-select').isDisabled(), modes.length === 0);
      if (modes.length) assert.ok(modes.some(mode => mode.id === session.mode), 'the confirmed effort belongs to the current model');
      else assert.equal(session.mode, '', 'models without effort options have no selected effort');
      const stored = readSession();
      assert.equal(stored.model, session.model);
      assert.equal(stored.mode, session.mode);
      assert.equal(stored.modelSelectionVerified, session.modelSelectionVerified);
    };
    const readConfirmedSession = async () => {
      const snapshot = await page.evaluate(() => window.tokyo.bootstrap());
      assert.equal(snapshot.connected, true);
      const session = snapshot.sessions.find(item => item.id === sessionId);
      assert.ok(session, 'the active session remains available from the engine');
      return session;
    };
    assert.equal(await page.locator('#mode-select').inputValue(), initial.mode, 'new chats expose the engine-confirmed effort');
    assert.equal(await page.locator('#model-select').inputValue(), initial.model, 'new chats expose the engine-confirmed model');
    assert.equal(await page.locator('option').filter({ hasText: '官方默认' }).count(), 0);
    await page.locator('.session-select').first().click();
    await page.waitForFunction(() => !document.querySelector('#model-select').disabled);
    await assertChoices(await readConfirmedSession());
    const offeredModels = initial.models || boot.info.models;
    assert.ok(offeredModels.length, 'the engine offers at least one model');
    const checked = [];
    for (const model of offeredModels.filter(item => !item.disabled)) {
      stage = 'model-selection';
      await page.locator('#model-select').selectOption(model.id);
      await page.waitForFunction(expected => document.querySelector('#model-select').value === expected && !document.querySelector('#model-select').disabled, model.id);
      const selected = await readConfirmedSession();
      assert.equal(selected.model, model.id);
      await assertChoices(selected);
      const offeredModes = selected.modes || [];
      const modesChecked = [];
      for (const mode of offeredModes.filter(item => !item.disabled)) {
        stage = 'effort-selection';
        await page.locator('#mode-select').selectOption(mode.id);
        await page.waitForFunction(expected => document.querySelector('#mode-select').value === expected && !document.querySelector('#mode-select').disabled, mode.id);
        const confirmed = await readConfirmedSession();
        assert.equal(confirmed.model, model.id);
        assert.equal(confirmed.mode, mode.id);
        assert.deepEqual(confirmed.modes.map(item => item.id), offeredModes.map(item => item.id), 'switching effort preserves the engine option order');
        await assertChoices(confirmed);
        modesChecked.push(mode.id);
      }
      checked.push({ model: model.id, modes: modesChecked });
    }
    await page.screenshot({ path: path.join(testRoot, 'official-effort.png') });
    stage = 'subagent-reconnect';
    await page.locator('#settings-button').click();
    await page.locator('#subagents-input').uncheck();
    await page.locator('#save-settings-button').click();
    await page.waitForFunction(() => document.querySelector('#connection-label').textContent.includes('已连接') && !document.querySelector('#model-select').disabled, null, { timeout: 60000 });
    assert.equal(readState().settings.subagentsEnabled, false);
    const current = await page.evaluate(() => window.tokyo.bootstrap());
    assert.equal(current.info.subagentsEnabled, false);
    await assertChoices(current.sessions.find(item => item.id === sessionId));
    await page.locator('#settings-button').click();
    assert.equal(await page.locator('#subagents-input').isChecked(), false);
    await page.screenshot({ path: path.join(testRoot, 'subagent-settings.png') });
    stage = 'compact-layout';
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
    await page.screenshot({ path: path.join(testRoot, 'compact-settings.png') });
    const layout = await page.evaluate(() => {
      const footer = document.querySelector('#save-settings-button').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth, footerVisible: footer.top >= 0 && footer.bottom <= innerHeight };
    });
    assert.equal(layout.overflow, false);
    assert.equal(layout.footerVisible, true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ packaged, engineChoices: checked, allEffortsApplied: true, modelEfforts: true, subagentReconnect: true, layout, errors, screenshots: testRoot }));
  } finally { await desktop.close(); }
})().catch(error => {
  // Never print engine payloads, account data, or arbitrary page error text.
  console.error(JSON.stringify({ passed: false, stage, error: error.name || 'Error' }));
  process.exitCode = 1;
});
