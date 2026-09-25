'use strict';

// Run the production main/preload/controller/renderer with an isolated, offline
// engine fixture. A late catalog must update both menus without a restart or send.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const base = path.join(root, 'work', 'model-refresh-qa');
fs.mkdirSync(base, { recursive: true });
const testRoot = fs.mkdtempSync(path.join(base, 'run-'));
const workspace = path.join(testRoot, 'Workspace');
const executable = path.join(testRoot, process.platform === 'win32' ? 'grok.exe' : 'grok');
const file = path.join(testRoot, 'data', 'conversations.json');
const sessionId = 'saved-model-refresh-session';
for (const folder of [workspace, path.dirname(file)]) fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(executable, 'Test fixture only; never executed.');
fs.chmodSync(executable, 0o755);
fs.writeFileSync(file, JSON.stringify({
  version: 1,
  settings: { executable, workspace, language: 'en', rainEnabled: false, musicEnabled: false },
  sessions: [{ id: sessionId, title: 'Saved model refresh session', cwd: workspace,
    model: 'grok-4.6', mode: 'medium', createdAt: Date.now(), updatedAt: Date.now(), messages: [] }],
}));
const readState = () => JSON.parse(fs.readFileSync(file, 'utf8'));

(async () => {
  const env = { ...process.env, TOKYO_TEST_ROOT: testRoot };
  if (process.argv.includes('--packaged')) env.TOKYO_UI_SOURCE_ROOT = require('../scripts/package-paths.cjs').packagedArchive(root);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TOKYO_TEST_HOLD;
  delete env.TOKYO_TEST_SIGNED_OUT;
  const desktop = await _electron.launch({ args: ['--mute-audio', path.join(__dirname, 'fixtures', 'ui-app.cjs')], env });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const engineCalls = () => desktop.evaluate(() => globalThis.__tokyoUITest.calls.map(({ method, sessionId }) => ({ method, sessionId })));
  const ready = () => page.waitForFunction(() => !document.querySelector('#model-select').disabled && !document.querySelector('#connection-button').disabled);
  const assertChoicesPreserved = async draft => {
    assert.equal(await page.locator('#model-select').inputValue(), 'grok-4.6');
    assert.equal(await page.locator('#mode-select').inputValue(), 'medium');
    assert.equal(await page.locator('#prompt').inputValue(), draft);
    assert.equal(await page.locator('#model-select option[value="grok-4.7"]').count(), 1);
  };
  try {
    await ready();
    assert.equal(await page.locator('#model-select option[value="grok-4.7"]').count(), 0);
    await page.locator('.session-select').filter({ hasText: 'Saved model refresh session' }).click();
    await ready();
    const draft = 'Keep this unsent draft while the engine discovers Grok 4.7.';
    await page.locator('#prompt').fill(draft);
    const initialCalls = await engineCalls();
    const originalLoadCount = initialCalls.filter(call => call.method === 'loadSession').length;

    await desktop.evaluate(() => {
      const fixture = globalThis.__tokyoUITest;
      const adapter = fixture.adapter;
      adapter.info.capabilities = { loadSession: true };
      // The ordinary fixture restores a saved catalog. Here the engine confirms
      // a fresh catalog while retaining the selected model and effort.
      adapter.loadSession = async function ({ sessionId, cwd }) {
        fixture.calls.push({ method: 'loadSession', sessionId, cwd });
        const session = structuredClone(this.sessions.get(sessionId) || fixture.records.get(sessionId));
        session.models = structuredClone(this.info.models);
        await fixture.waitForGate('loadSession');
        this.sessions.set(sessionId, session);
        return this.publish(session);
      };
      fixture.hold('loadSession');
      const reference = adapter.info.models.find(model => model.id === 'grok-4.6');
      adapter.info.models = [...adapter.info.models, { ...structuredClone(reference), id: 'grok-4.7', name: 'Grok 4.7' }];
      adapter.emit('event', { type: 'status', status: 'models_changed', revision: 1 });
      adapter.emit('event', { type: 'status', status: 'models_changed', revision: 1 });
    });
    // Waiting on the fixture gate proves an actual session readback happened;
    // the assertion cannot pass merely because the global catalog was merged.
    await page.waitForFunction(async () => {
      const snapshot = await window.tokyo.initialState();
      return snapshot.info.models.some(model => model.id === 'grok-4.7');
    });
    const deadline = Date.now() + 10000;
    while (!await desktop.evaluate(() => globalThis.__tokyoUITest.gates.get('loadSession')?.entered === true)) {
      assert.ok(Date.now() < deadline, 'late catalog must trigger a session readback');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(await page.locator('#prompt').inputValue(), draft);
    await desktop.evaluate(() => globalThis.__tokyoUITest.release('loadSession'));
    await page.waitForFunction(() => document.querySelector('#model-select option[value="grok-4.7"]'));
    await ready();
    await assertChoicesPreserved(draft);
    assert.equal(readState().sessions[0].model, 'grok-4.6');
    assert.equal(readState().sessions[0].mode, 'medium');
    assert.ok(readState().sessions[0].models.some(model => model.id === 'grok-4.7'));

    await page.locator('#new-session').click();
    const newDraft = 'Separate new-conversation draft.';
    await page.locator('#prompt').fill(newDraft);
    await assertChoicesPreserved(newDraft);
    await page.locator('.session-select').filter({ hasText: 'Saved model refresh session' }).click();
    await ready();
    await assertChoicesPreserved(draft);
    await page.locator('#new-session').click();
    await assertChoicesPreserved(newDraft);

    const finalCalls = await engineCalls();
    assert.equal(finalCalls.filter(call => call.method === 'loadSession').length, originalLoadCount + 1, 'duplicate catalog revision must not reload twice');
    assert.equal(finalCalls.filter(call => call.method === 'constructor').length, 1, 'engine must not restart');
    assert.equal(finalCalls.filter(call => call.method === 'start').length, 1);
    for (const method of ['prompt', 'setModel', 'setMode', 'newSession']) {
      assert.equal(finalCalls.filter(call => call.method === method).length, 0, `catalog refresh must not invoke ${method}`);
    }
    assert.deepEqual(readState().sessions[0].messages, []);
    assert.deepEqual(errors, []);
    console.log('PASS late model catalog updates existing and new conversation menus, preserves drafts and choices, and coalesces duplicate notifications without restarting or sending.');
  } catch (error) {
    await page.screenshot({ path: path.join(testRoot, 'failure.png'), animations: 'disabled' }).catch(() => {});
    throw error;
  } finally {
    await desktop.evaluate(() => {
      const fixture = globalThis.__tokyoUITest;
      for (const method of [...fixture.gates.keys()]) fixture.release(method);
    }).catch(() => {});
    await desktop.close();
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
