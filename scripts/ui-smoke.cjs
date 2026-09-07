// Ordinary QA never sends paid prompts; the old live check requires --live.
if (!process.argv.includes('--live')) {
  require('../tests/ui-controls.cjs');
} else {
const { _electron: electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = process.env.TOKYO_QA_OUTPUT || path.join(root, 'work', 'ui-qa');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const errors = [];
  const env = { ...process.env, TOKYO_TEST_ROOT: path.join(root, 'work', 'ui-test-data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await electron.launch({ args: [root], env });
  try {
    const page = await desktop.firstWindow();
    page.on('pageerror', e => errors.push(e.message));
    await page.waitForFunction(() => document.querySelector('#connection-label')?.textContent === window.TokyoI18n.t('引擎已连接'), { timeout: 60000 });
    await page.screenshot({ path: path.join(output, 'welcome.png') });
    const state = await page.evaluate(() => ({
      title: document.title,
      connection: document.querySelector('#connection-label')?.textContent,
      models: [...document.querySelector('#model-select').options].map(o => ({ value: o.value, text: o.textContent })),
      bridge: typeof window.tokyo?.send,
      node: typeof window.require,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    console.log(JSON.stringify({ stage: 'boot', ...state }));
    assert.equal(state.bridge, 'function');
    assert.equal(state.node, 'undefined');
    assert.equal(state.overflow, false);
    await page.locator('#settings-button').click();
    await page.locator('#settings-dialog').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#executable-input').inputValue()).endsWith('grok.exe'));
    await page.screenshot({ path: path.join(output, 'settings.png') });
    await page.locator('[data-close-dialog="settings-dialog"]').click();
    console.log(JSON.stringify({ stage: 'settings', passed: true }));
    await page.locator('#new-session').click();
    const modes = await page.locator('#mode-select option').evaluateAll(items => items.map(o => o.value));
    if (modes.includes('low')) await page.locator('#mode-select').selectOption('low');
    await page.locator('#prompt').fill('只回复“东京连接成功”，不要调用任何工具。');
    await page.locator('#send-button').click();
    await page.waitForFunction(() => document.querySelector('#messages')?.textContent.includes('东京连接成功') && document.querySelector('#stop-button')?.hidden, { timeout: 120000 });
    await page.screenshot({ path: path.join(output, 'chat.png') });
    const persisted = JSON.parse(fs.readFileSync(path.join(env.TOKYO_TEST_ROOT, 'data', 'conversations.json'), 'utf8'));
    const session = persisted.sessions.find(s => s.messages.some(m => m.role === 'assistant' && m.text.includes('东京连接成功')));
    assert.ok(session, 'actual assistant reply is persisted');
    assert.equal(session.messages.filter(m => m.role === 'user').length, 1);
    assert.equal(session.messages.filter(m => m.role === 'assistant').length, 1);
    console.log(JSON.stringify({ stage: 'actual-ui-send', passed: true, assistant: session.messages.find(m => m.role === 'assistant').text, model: session.model, mode: session.mode }));
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 720));
    await page.screenshot({ path: path.join(output, 'compact.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ stage: 'complete', errors, screenshots: output }));
  } finally { await desktop.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
}
