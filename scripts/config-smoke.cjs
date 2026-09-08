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

(async () => {
  const env = { ...process.env, TOKYO_TEST_ROOT: testRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.argv.includes('--packaged');
  const desktop = await _electron.launch(packaged
    ? { executablePath: packagedExecutable(root), args: [], env }
    : { args: [root], env });
  try {
    const page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#connection-label').textContent.includes('已连接') && !document.querySelector('#settings-button').disabled, { timeout: 60000 });
    const readState = () => JSON.parse(fs.readFileSync(path.join(testRoot, 'data', 'conversations.json'), 'utf8'));
    const initial = readState().sessions[0];
    assert.equal(await page.locator('#mode-select').inputValue(), initial.mode, 'new chats expose the engine-confirmed effort');
    assert.equal(await page.locator('#model-select').inputValue(), initial.model, 'new chats expose the engine-confirmed model');
    assert.equal(await page.locator('option').filter({ hasText: '官方默认' }).count(), 0);
    await page.locator('.session-select').first().click();
    for (const [value, label] of [['low', '低推理强度'], ['medium', '中等推理强度'], ['high', '高推理强度'], ['xhigh', '超高推理强度']]) {
      assert.equal(await page.locator(`#mode-select option[value="${value}"]`).textContent(), label);
      await page.locator('#mode-select').selectOption(value);
      await page.waitForFunction(expected => document.querySelector('#mode-select').value === expected && !document.querySelector('#mode-select').disabled, value);
      assert.equal(readState().sessions[0].mode, value);
      assert.equal(readState().sessions[0].modelSelectionVerified, true);
    }
    await page.locator('#model-select').selectOption('grok-4.5');
    await page.waitForFunction(() => document.querySelector('#model-select').value === 'grok-4.5' && !document.querySelector('#model-select').disabled);
    assert.equal(await page.locator('#mode-select option[value="xhigh"]').count(), 0);
    await page.locator('#model-select').selectOption('grok-4');
    await page.waitForFunction(() => document.querySelector('#model-select').value === 'grok-4' && !document.querySelector('#model-select').disabled);
    assert.equal(await page.locator('#mode-select').isDisabled(), true);
    await page.locator('#model-select').selectOption('grok-4.6');
    await page.waitForFunction(() => document.querySelector('#model-select').value === 'grok-4.6' && !document.querySelector('#model-select').disabled);
    await page.screenshot({ path: path.join(testRoot, 'official-effort.png') });
    await page.locator('#settings-button').click();
    await page.locator('#subagents-input').uncheck();
    await page.locator('#save-settings-button').click();
    await page.waitForFunction(() => document.querySelector('#connection-label').textContent.includes('已连接') && !document.querySelector('#model-select').disabled, { timeout: 60000 });
    assert.equal(readState().settings.subagentsEnabled, false);
    const current = await page.evaluate(() => window.tokyo.bootstrap());
    assert.equal(current.info.subagentsEnabled, false);
    assert.equal(current.sessions[0].modelSelectionVerified, true);
    await page.locator('#settings-button').click();
    assert.equal(await page.locator('#subagents-input').isChecked(), false);
    await page.screenshot({ path: path.join(testRoot, 'subagent-settings.png') });
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
    await page.screenshot({ path: path.join(testRoot, 'compact-settings.png') });
    const layout = await page.evaluate(() => {
      const footer = document.querySelector('#save-settings-button').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth, footerVisible: footer.top >= 0 && footer.bottom <= innerHeight };
    });
    assert.equal(layout.overflow, false);
    assert.equal(layout.footerVisible, true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ packaged, officialNames: true, allEffortsApplied: true, modelEfforts: true, subagentReconnect: true, layout, errors, screenshots: testRoot }));
  } finally { await desktop.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
