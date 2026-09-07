'use strict';

// Test-only entry point: exercise the production main, preload, controller and
// renderer while replacing only the paid CLI and native chooser destinations.
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const { app, dialog, shell } = require('electron');
const root = process.env.TOKYO_TEST_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('An isolated TOKYO_TEST_ROOT is required');
process.env.GROK_HOME = path.join(root, 'default-grok');
for (const key of ['GROK_AUTH', 'GROK_AUTH_PATH', 'XAI_API_KEY', 'GROK_CODE_XAI_API_KEY']) delete process.env[key];
const sourceRoot = process.env.TOKYO_UI_SOURCE_ROOT || path.resolve(__dirname, '../..');
const test = globalThis.__tokyoUITest = { calls: [], dialogs: [], external: [], saved: [], adapters: [], records: new Map(), nextSession: 0 };
const copy = value => structuredClone(value);
const efforts = ['low', 'medium', 'high', 'xhigh'].map((id, index) => ({ id, name: ['Low Effort', 'Medium Effort', 'High Effort', 'Extra High Effort'][index], value: id }));
const models = [
  { id: 'grok-4.6', name: 'Grok 4.6', reasoningEfforts: efforts, reasoningEffort: 'medium' },
  { id: 'grok-4.5', name: 'Grok 4.5', reasoningEfforts: efforts.slice(0, 3), reasoningEffort: 'medium' },
  { id: 'grok-4', name: 'Grok 4', reasoningEfforts: [] },
  { id: 'grok-discovered', name: 'Grok Discovered' },
];
class FakeAdapter extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.sessions = new Map(); this.pending = new Map();
    this.info = { version: 'UI-TEST', models, modes: efforts, currentModelId: 'grok-4.6', currentModeId: 'medium', subagentsEnabled: options.subagentsEnabled };
    test.adapters.push(this); test.adapter = this;
    test.calls.push({ method: 'constructor', options });
  }
  getInfo() { return copy(this.info); }
  getSession(id) { return copy(this.sessions.get(id)); }
  async start() { test.calls.push({ method: 'start' }); this.emit('event', { type: 'status', status: 'ready' }); }
  publish(session) {
    test.records.set(session.sessionId, copy(session));
    this.info.currentModelId = session.model; this.info.currentModeId = session.mode; this.info.modes = session.modes;
    return copy(session);
  }
  async newSession({ cwd, model = 'grok-4.6', mode }) {
    const choices = model === 'grok-discovered' ? efforts.slice(0, 3) : models.find(item => item.id === model)?.reasoningEfforts || [];
    const session = { sessionId: `ui-session-${++test.nextSession}`, cwd, model, mode: mode || (choices.length ? 'medium' : ''), models, modes: choices, loaded: true, modelSelectionVerified: true };
    this.sessions.set(session.sessionId, session); test.calls.push({ method: 'newSession', cwd, model, mode }); return this.publish(session);
  }
  async loadSession({ sessionId, cwd }) {
    test.calls.push({ method: 'loadSession', sessionId, cwd });
    const session = copy(test.records.get(sessionId) || { sessionId, cwd, model: 'grok-4.6', mode: 'medium', models, modes: efforts, loaded: true, modelSelectionVerified: true });
    this.sessions.set(sessionId, session); return this.publish(session);
  }
  async setModel({ sessionId, model }) {
    test.calls.push({ method: 'setModel', sessionId, model });
    if (test.failModel) { test.failModel = false; throw new Error('UI fixture: model update rejected'); }
    const session = this.sessions.get(sessionId); const choices = models.find(item => item.id === model)?.reasoningEfforts || [];
    Object.assign(session, { model, modes: choices, mode: choices.length ? 'medium' : '', modelSelectionVerified: true });
    return this.publish(session);
  }
  async setMode({ sessionId, mode }) {
    test.calls.push({ method: 'setMode', sessionId, mode });
    if (test.failMode) { test.failMode = false; throw new Error('UI fixture: effort update rejected'); }
    this.sessions.get(sessionId).mode = mode; return this.publish(this.sessions.get(sessionId));
  }
  async prompt({ sessionId, text }) {
    test.calls.push({ method: 'prompt', sessionId, text });
    if (test.failPrompt) { test.failPrompt = false; throw new Error('UI fixture: request rejected'); }
    if (text.startsWith('WAIT') || text.startsWith('PERMISSION')) {
      const promise = new Promise(resolve => this.pending.set(sessionId, resolve));
      if (text.startsWith('PERMISSION')) this.emit('event', { type: 'permission', sessionId, requestId: `request-${sessionId}`, title: 'Fixture permission', description: 'Test-only operation', options: [
        { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }, { optionId: 'allow-always', name: '始终允许', kind: 'allow_always' },
        { optionId: 'reject-once', name: '拒绝一次', kind: 'reject_once' }, { optionId: 'reject-always', name: '始终拒绝', kind: 'reject_always' },
      ] });
      return promise;
    }
    this.emit('event', { type: 'thought', sessionId, text: 'Fixture reasoning' });
    this.emit('event', { type: 'tool', sessionId, toolCallId: 'fixture-tool', title: 'Fixture tool', status: 'completed', content: 'Fixture output' });
    this.emit('event', { type: 'text', sessionId, text: 'Fixture reply\n\n```js\nconsole.log("Tokyo");\n```\n\n[Example](https://example.com/test)\n\n<script>window.__unsafe = true</script>' });
    return { stopReason: 'end_turn' };
  }
  async cancel(sessionId) { test.calls.push({ method: 'cancel', sessionId }); this.pending.get(sessionId)?.({ stopReason: 'cancelled' }); this.pending.delete(sessionId); }
  async respondPermission(args) {
    test.calls.push({ method: 'respondPermission', ...args });
    if (test.failPermission) { test.failPermission = false; throw new Error('UI fixture: permission rejected'); }
    if (!test.holdPermission) for (const [id, resolve] of this.pending) { resolve({ stopReason: 'end_turn' }); this.pending.delete(id); }
  }
  async close() { test.calls.push({ method: 'close' }); for (const resolve of this.pending.values()) resolve({ stopReason: 'cancelled' }); this.pending.clear(); }
}
const adapterFile = path.join(sourceRoot, 'src', 'grok-adapter.cjs');
require.cache[adapterFile] = { id: adapterFile, filename: adapterFile, loaded: true, exports: { GrokAdapter: FakeAdapter } };
const accountsFile = path.join(sourceRoot, 'src', 'account-manager.cjs');
const { AccountManager, ACCOUNT_ID } = require(accountsFile);
class FakeAccounts extends AccountManager {
  constructor(options) {
    super({ ...options, spawnProcess: (executable, args, options) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      test.calls.push({ method: 'login', args, grokHome: options.env.GROK_HOME, windowsHide: options.windowsHide });
      child.kill = () => { setImmediate(() => child.emit('close', 1)); return true; };
      test.finishLogin = (success = true) => {
        if (success) fs.writeFileSync(path.join(options.env.GROK_HOME, 'auth.json'), JSON.stringify({ 'https://auth.x.ai': { key: 'fixture-not-a-real-credential', auth_mode: 'oidc', email: 'tokyo@example.test' } }));
        child.emit('close', success ? 0 : 1);
      };
      setImmediate(() => child.stderr.write('To sign in, open this URL in your browser:\n\n  https://auth.x.ai/device\n\nConfirm this code in your browser:\n\n  TEST-1234\n\nWaiting for authorization...\n'));
      return child;
    } });
  }
}
require.cache[accountsFile] = { id: accountsFile, filename: accountsFile, loaded: true, exports: { AccountManager: FakeAccounts, ACCOUNT_ID } };
dialog.showOpenDialog = async (_win, options) => {
  test.calls.push({ method: 'showOpenDialog', options });
  return test.dialogs.shift() || { canceled: true, filePaths: [] };
};
dialog.showSaveDialog = async (_win, options) => {
  test.calls.push({ method: 'showSaveDialog', options });
  const result = test.dialogs.shift() || { canceled: true };
  if (result.filePath) test.saved.push(result.filePath);
  return result;
};
shell.openExternal = async url => { test.external.push(url); };
app.setPath('userData', path.join(root, 'data', 'browser'));
require(path.join(sourceRoot, 'src', 'main.cjs'));
