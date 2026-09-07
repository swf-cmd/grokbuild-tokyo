'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { AppController } = require('../src/app-controller.cjs');

// Fixtures must never resolve the caller's inline or redirected authentication.
for (const key of ['GROK_AUTH', 'GROK_AUTH_PATH', 'XAI_API_KEY', 'GROK_CODE_XAI_API_KEY']) delete process.env[key];

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function signIn(controller, account) {
  const home = controller.accountManager.homeFor(account.id);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ scope: { key: 'fixture-credential', auth_mode: 'oidc', email: 'fixture@example.test' } }));
}

function fixture(t, saved, { useAppLanguage = false } = {}) {
  const base = path.resolve(__dirname, '..', 'work', 'controller-tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'run-'));
  const executable = path.join(root, 'home', '.grok', 'bin', 'grok.exe');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'fake executable; never launched');
  if (saved !== undefined) {
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data', 'conversations.json'), typeof saved === 'string' ? saved : JSON.stringify(saved));
  }
  const instances = [];
  let nextSession = 0;
  class FakeAdapter extends EventEmitter {
    constructor(options) {
      super();
      instances.push(this);
      this.options = options;
      this.prompts = [];
      this.loads = [];
      this.responses = [];
      this.cancels = [];
      this.sessions = new Map();
      this.configurations = [];
      this.closeCount = 0;
      this.info = { models: [{ id: 'grok-test', name: 'Grok Test' }], modes: [{ id: 'balanced', name: 'Balanced' }], currentModelId: 'grok-test', currentModeId: 'balanced' };
    }
    getInfo() { return this.info; }
    getSession(id) { const session = this.sessions.get(id); return session && structuredClone(session); }
    async start() { if (this.startGate) await this.startGate.promise; }
    async newSession() {
      if (this.newGate) await this.newGate.promise;
      const session = { sessionId: `session-${++nextSession}`, loaded: true, model: 'grok-test', mode: 'balanced', models: this.info.models, modes: this.info.modes, modelSelectionVerified: true, ...this.newResult };
      this.sessions.set(session.sessionId, session);
      return this.getSession(session.sessionId);
    }
    async loadSession(args) {
      this.loads.push(args);
      if (this.loadGate) await this.loadGate.promise;
      const session = { sessionId: args.sessionId, loaded: true, model: this.info.currentModelId, mode: this.info.currentModeId, modes: this.info.modes, modelSelectionVerified: true, ...this.loadResult };
      this.sessions.set(args.sessionId, session);
      return this.getSession(args.sessionId);
    }
    async setModel({ sessionId, model }) {
      this.configurations.push({ type: 'model', sessionId, model });
      if (this.modelGate) await this.modelGate.promise;
      Object.assign(this.sessions.get(sessionId), { model, modelSelectionVerified: true });
      this.info.currentModelId = model;
      return this.getSession(sessionId);
    }
    async setMode({ sessionId, mode }) {
      this.configurations.push({ type: 'mode', sessionId, mode });
      if (this.modeGate) await this.modeGate.promise;
      this.sessions.get(sessionId).mode = mode;
      this.info.currentModeId = mode;
      return this.getSession(sessionId);
    }
    async prompt(args) {
      const gate = deferred();
      this.prompts.push({ ...args, gate });
      return gate.promise;
    }
    async cancel(sessionId) { this.cancels.push(sessionId); this.prompts.find(p => p.sessionId === sessionId)?.gate.resolve({ stopReason: 'cancelled' }); }
    async respondPermission(args) { this.responses.push(args); }
    async close() { this.closeCount++; if (this.closeGate) await this.closeGate.promise; for (const p of this.prompts) p.gate.resolve({ stopReason: 'cancelled' }); }
  }
  const controller = new AppController({ root, home: path.join(root, 'home'), Adapter: FakeAdapter });
  // Diagnostic assertions use an explicit locale; language tests exercise the app default.
  if (!useAppLanguage) controller.settings.language = 'zh-CN';
  controller.accountManager.defaultHome = path.join(root, 'home', '.grok');
  t.after(async () => {
    for (const adapter of instances) for (const gate of ['startGate', 'newGate', 'loadGate', 'modelGate', 'modeGate', 'closeGate']) adapter[gate]?.resolve();
    await controller.close();
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(base + path.sep), 'test cleanup must remain inside its scratch directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, controller, instances };
}

async function started(t, options) {
  const result = fixture(t, undefined, options);
  result.session = await result.controller.createSession();
  result.adapter = result.instances[0];
  return result;
}

test('attachment-only turns preserve files, validate tokens and survive restart', async t => {
  const { root, controller, session, adapter } = await started(t);
  const [file] = await controller.importAttachments({ files: [{ name: 'report.txt', data: Buffer.from('hello file').toString('base64') }] });
  await assert.rejects(controller.send({ sessionId: session.id, attachments: [{ id: 'forged', src: 'C:\\private' }] }), /失效/);
  assert.equal(controller.active, null);
  assert.deepEqual(await controller.send({ sessionId: session.id, attachments: [{ id: file.id, src: 'ignored' }] }), { accepted: true });
  assert.equal(adapter.prompts[0].text, '');
  assert.equal(adapter.prompts[0].attachments[0].path, file.src);
  assert.match(adapter.prompts[0].attachments[0].uri, /^file:/);
  assert.equal(session.messages[0].attachments[0].name, 'report.txt');
  assert.equal(session.title, 'report.txt');
  adapter.emit('event', { type: 'text', sessionId: session.id, text: '[result](result.txt)' });
  fs.writeFileSync(path.join(session.cwd, 'result.txt'), 'generated file');
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' }); await controller.turnPromise;
  const received = session.messages[1].attachments[0];
  assert.equal((await controller.attachmentBytes({ sessionId: session.id, attachmentId: received.id })).toString(), 'generated file');
  assert.match(controller.exportMarkdown(session.id), /report\.txt/);
  const restored = new AppController({ root, home: path.join(root, 'home'), Adapter: controller.Adapter });
  assert.equal((await restored.attachmentBytes({ sessionId: session.id, attachmentId: file.id })).toString(), 'hello file');
  await restored.close();
});

test('attachments cannot cross accounts or escape allowed download directories', async t => {
  const { controller, session } = await started(t);
  await assert.rejects(controller.importAttachments({ files: [{ name: 'wrong-account.txt', data: '' }], accountId: 'other-account' }), /失效/);
  const [file] = await controller.importAttachments({ files: [{ name: 'private.txt', data: 'cHJpdmF0ZQ==' }] });
  controller.pendingAttachments.get(file.id).accountId = 'other-account';
  await assert.rejects(controller.send({ sessionId: session.id, text: 'read', attachments: [{ id: file.id }] }), /失效/);
  await assert.rejects(controller.attachmentBytes({ sessionId: session.id, attachmentId: file.id }), /失效/);
  session.messages.push({ role: 'assistant', text: '', attachments: [{ id: 'outside', src: controller.file, name: 'private.json' }] });
  await assert.rejects(controller.attachmentBytes({ sessionId: session.id, attachmentId: 'outside' }), /允许的目录/);
});

test('execution plans replace prior entries, ignore replay and other sessions, and survive restart', async t => {
  const { controller, session, adapter } = await started(t);
  await controller.send({ sessionId: session.id, text: 'Plan a change' });
  const publish = (entries, extra = {}) => adapter.emit('event', { type: 'status', status: 'plan', sessionId: session.id, entries, ...extra });
  publish([{ content: 'Inspect', status: 'in_progress', priority: 'high' }]);
  publish([{ content: 'Wrong session' }], { sessionId: 'unrelated' });
  publish([{ content: 'Old replay' }], { replay: true });
  assert.deepEqual(session.messages[1].plan, [{ content: 'Inspect', status: 'in_progress', priority: 'high' }]);
  publish([]);
  assert.deepEqual(session.messages[1].plan, []);
  publish([null, { content: 42 }, { content: 'Done', status: 'completed', priority: 'high' }, { content: 'Next', status: 'unexpected' }]);
  const expected = [{ content: 'Done', status: 'completed', priority: 'high' }, { content: 'Next', status: 'pending', priority: 'medium' }];
  assert.deepEqual(session.messages[1].plan, expected);
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
  const saved = JSON.parse(fs.readFileSync(controller.file, 'utf8'));
  assert.deepEqual(saved.sessions[0].messages[1].plan, expected);
  const restored = fixture(t, saved).controller;
  assert.deepEqual(restored.sessions[0].messages[1].plan, expected);
  assert.match(restored.exportMarkdown(session.id), /### 执行计划\n\n- \[x\] Done\n- \[ \] Next/);
  publish([{ content: 'Late event' }]);
  assert.deepEqual(session.messages[1].plan, expected);
});

test('Grok turn limits and refusal preserve a translatable notice without blocking the next message', async t => {
  const { controller, session, adapter } = await started(t);
  const notices = {
    max_tokens: '回复达到输出长度上限，可发送消息让 Grok 继续。',
    max_turn_requests: '本轮已达到请求次数上限，可发送消息让 Grok 继续。',
    refusal: 'Grok 拒绝了这次请求。',
  };
  for (const [stopReason, notice] of Object.entries(notices)) {
    await controller.send({ sessionId: session.id, text: 'Continue' });
    adapter.prompts.at(-1).gate.resolve({ stopReason });
    await controller.turnPromise;
    const message = session.messages.at(-1);
    assert.equal(message.status, 'complete');
    assert.equal(message.stopReason, stopReason);
    assert.equal(message.noticeKey, notice);
    assert.equal(controller.active, null);
    const saved = JSON.parse(fs.readFileSync(controller.file, 'utf8'));
    assert.equal(saved.sessions[0].messages.at(-1).noticeKey, notice);
    assert.ok(controller.exportMarkdown(session.id).includes(notice));
  }
});

test('controller image reads find Grok caches for punctuation and hashed multilingual workspaces', async t => {
  const { controller, session, root } = await started(t);
  const grokHome = controller.accountManager.homeFor('local');
  const image = fs.readFileSync(path.resolve(__dirname, '../src/renderer/assets/icon.png'));
  const check = async (cwd, directory, metadata = false) => {
    fs.mkdirSync(cwd, { recursive: true });
    const parent = path.join(grokHome, 'sessions', directory);
    const cache = path.join(parent, session.id, 'images');
    fs.mkdirSync(cache, { recursive: true });
    if (metadata) fs.writeFileSync(path.join(parent, '.cwd'), cwd);
    fs.writeFileSync(path.join(cache, 'result.png'), image);
    session.cwd = cwd;
    assert.equal((await controller.readImage({ sessionId: session.id, src: 'images/result.png' })).src, `data:image/png;base64,${image.toString('base64')}`);
  };
  const short = path.join(root, "Tokyo (夜)!");
  await check(short, encodeURIComponent(short).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()));
  const long = path.join(root, '東京'.repeat(30));
  await check(long, 'tokyo-workspace-0123456789abcdef', true);
});

test('a new conversation remembers the model and mode selected by Grok', async t => {
  const { controller, session } = await started(t);
  assert.equal(session.model, 'grok-test');
  assert.equal(session.mode, 'balanced');
  const saved = JSON.parse(fs.readFileSync(controller.file, 'utf8'));
  assert.equal(saved.sessions[0].model, 'grok-test');
});

test('streamed assistant text and tool updates persist without echoing user or replay messages', async t => {
  const { controller, session, adapter } = await started(t);
  await controller.send({ sessionId: session.id, text: '  hello  ' });
  for (const event of [
    { type: 'text', role: 'user', text: 'hello' },
    { type: 'text', role: 'assistant', text: 'old answer', replay: true },
    { type: 'text', role: 'assistant', text: 'Hello ' },
    { type: 'text', role: 'assistant', text: 'Tokyo.' },
    { type: 'thought', text: 'Working through it.' },
    { type: 'tool', toolCallId: 'read-1', title: 'Read file', status: 'pending' },
    { type: 'tool', toolCallId: 'read-1', status: 'completed' },
  ]) adapter.emit('event', { sessionId: session.id, ...event });
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
  const saved = JSON.parse(fs.readFileSync(controller.file, 'utf8')).sessions[0];
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.messages[0].text, 'hello');
  assert.equal(saved.messages[1].text, 'Hello Tokyo.');
  assert.equal(saved.messages[1].thought, 'Working through it.');
  assert.deepEqual(saved.messages[1].tools.map(x => [x.toolCallId, x.title, x.status]), [['read-1', 'Read file', 'completed']]);
  assert.equal(saved.messages[1].status, 'complete');
  assert.equal(controller.active, null);
});

test('a second send is rejected while an existing conversation is being restored', async t => {
  const { controller, session, adapter } = await started(t);
  controller.loaded.clear();
  adapter.loadGate = deferred();
  const first = controller.send({ sessionId: session.id, text: 'first' });
  await assert.rejects(controller.send({ sessionId: session.id, text: 'second' }), /已有回复/);
  adapter.loadGate.resolve();
  await first;
  assert.equal(adapter.prompts.length, 1);
  assert.equal(adapter.prompts[0].text, 'first');
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
});

test('cancelling during session restore prevents a later prompt from starting', async t => {
  const { controller, session, adapter } = await started(t);
  controller.loaded.clear();
  adapter.loadGate = deferred();
  const sending = controller.send({ sessionId: session.id, text: 'do not run this' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.loads.length, 1);
  await controller.cancel(session.id);
  adapter.loadGate.resolve();
  await Promise.allSettled([sending]);
  assert.equal(adapter.prompts.length, 0, 'a cancelled restoration must never trigger work after the user stops');
  assert.equal(controller.active, null);
});

test('stopping a streamed reply keeps partial output and releases the next send', async t => {
  const { controller, session, adapter } = await started(t);
  await controller.send({ sessionId: session.id, text: 'first' });
  adapter.emit('event', { type: 'text', sessionId: session.id, text: 'partial' });
  await controller.cancel(session.id);
  await controller.turnPromise;
  assert.equal(session.messages[1].status, 'cancelled');
  assert.equal(session.messages[1].text, 'partial');
  await controller.send({ sessionId: session.id, text: 'next' });
  assert.equal(adapter.prompts.length, 2);
  adapter.prompts[1].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
});

test('a failed session restore leaves history unchanged and allows retry', async t => {
  const { controller, session, adapter } = await started(t);
  controller.loaded.clear();
  adapter.loadGate = deferred();
  const sending = controller.send({ sessionId: session.id, text: 'restore me' });
  adapter.loadGate.reject(new Error('restore unavailable'));
  await assert.rejects(sending, /restore unavailable/);
  assert.equal(session.messages.length, 0);
  assert.equal(controller.active, null);
  adapter.loadGate = null;
  await controller.send({ sessionId: session.id, text: 'retry' });
  assert.equal(adapter.prompts.length, 1);
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
});

test('a failed prompt preserves its error and partial output without blocking a future turn', async t => {
  const { controller, session, adapter } = await started(t);
  await controller.send({ sessionId: session.id, text: 'question' });
  adapter.emit('event', { type: 'text', sessionId: session.id, text: 'partial answer' });
  adapter.prompts[0].gate.reject(new Error('connection interrupted'));
  await controller.turnPromise;
  assert.equal(session.messages[1].status, 'error');
  assert.equal(session.messages[1].error, 'connection interrupted');
  assert.equal(session.messages[1].text, 'partial answer');
  assert.equal(controller.active, null);
  await controller.send({ sessionId: session.id, text: 'try again' });
  adapter.prompts[1].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
  assert.equal(session.messages[3].status, 'complete');
});

test('only offered permission choices are sent to the adapter and requests cannot be reused', async t => {
  const { controller, adapter, session } = await started(t);
  adapter.emit('event', { type: 'permission', sessionId: session.id, requestId: '42', options: [{ optionId: 'allow-once' }, { optionId: 'reject' }] });
  await assert.rejects(controller.permission({ requestId: '42', optionId: 'invented' }), /授权/);
  assert.equal(adapter.responses.length, 0);
  await controller.permission({ requestId: '42', optionId: 'allow-once' });
  await assert.rejects(controller.permission({ requestId: '42', optionId: 'allow-once' }), /授权/);
  assert.deepEqual(adapter.responses, [{ requestId: '42', optionId: 'allow-once' }]);
});

test('a disconnected process is replaced and the conversation is restored before the next prompt', async t => {
  const { controller, session, adapter, instances } = await started(t);
  adapter.emit('event', { type: 'status', status: 'disconnected' });
  assert.equal(controller.connected, false);
  await controller.send({ sessionId: session.id, text: 'resume' });
  assert.equal(instances.length, 2);
  assert.deepEqual(instances[1].loads, [{ sessionId: session.id, cwd: session.cwd }]);
  assert.equal(instances[1].prompts[0].text, 'resume');
  instances[1].prompts[0].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
});

test('restart marks an interrupted reply cancelled and leaves completed history intact', async t => {
  const { controller } = fixture(t, { settings: {}, sessions: [{ id: 'old', title: 'Saved', cwd: 'unused', messages: [{ role: 'user', text: 'question', status: 'complete' }, { role: 'assistant', text: 'partial', status: 'working' }] }] });
  const old = await controller.selectSession('old');
  assert.equal(old.messages[0].status, 'complete');
  assert.equal(old.messages[1].status, 'cancelled');
  assert.match(controller.exportMarkdown('old'), /partial/);
});

test('invalid history is backed up and recovery starts with a usable empty conversation list', t => {
  const { controller } = fixture(t, { settings: {}, sessions: [null] });
  assert.match(controller.loadError, /backup/);
  assert.deepEqual(controller.sessions, []);
  const backups = fs.readdirSync(controller.dir).filter(name => name.includes('.unreadable-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(controller.dir, backups[0]), 'utf8')).sessions, [null]);
});

test('creation records confirmed engine choices instead of overwriting them with requested values', async t => {
  const { controller } = fixture(t);
  const session = await controller.createSession({ model: 'requested-model', mode: 'requested-mode' });
  assert.equal(session.model, 'grok-test');
  assert.equal(session.mode, 'balanced');
  assert.equal(session.modelSelectionVerified, true);
  assert.deepEqual(session.modes, [{ id: 'balanced', name: 'Balanced' }]);
});

test('restoring and selecting a session replace stale settings with actual engine state', async t => {
  const { controller, adapter, session } = await started(t);
  Object.assign(session, { model: 'old-model', mode: 'old-mode', modes: [{ id: 'old-mode', name: 'Old' }] });
  adapter.loadResult = { model: 'server-model', mode: 'medium', modes: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] };
  controller.loaded.clear();
  const selected = await controller.selectSession(session.id);
  assert.equal(selected.model, 'server-model');
  assert.equal(selected.mode, 'medium');
  assert.deepEqual(selected.modes, adapter.loadResult.modes);
  assert.equal(selected.modelSelectionVerified, true);
  assert.deepEqual(adapter.configurations, [], 'restoring must not reapply old local choices');
  const saved = JSON.parse(fs.readFileSync(controller.file, 'utf8')).sessions[0];
  assert.equal(saved.model, 'server-model');
  assert.equal(saved.mode, 'medium');
});

test('offline and failed restores keep history readable without claiming verified model settings', async t => {
  const { controller, adapter, session } = await started(t);
  session.messages.push({ role: 'assistant', text: 'retained history', status: 'complete' });
  controller.connected = false;
  assert.equal((await controller.selectSession(session.id)).modelSelectionVerified, false);
  assert.equal(adapter.loads.length, 0);
  controller.connected = true;
  controller.loaded.clear();
  adapter.loadGate = deferred();
  const selecting = controller.selectSession(session.id);
  adapter.loadGate.reject(new Error('cannot restore'));
  const selected = await selecting;
  assert.equal(selected.messages[0].text, 'retained history');
  assert.equal(selected.modelSelectionVerified, false);
  assert.equal(controller.operation, null);
});

test('session configuration waits for restoration and applies model before reasoning mode', async t => {
  const { controller, adapter, session } = await started(t);
  controller.loaded.clear();
  adapter.loadGate = deferred();
  const events = [];
  controller.on('event', event => events.push(structuredClone(event)));
  const configuring = controller.configureSession({ sessionId: session.id, model: 'new-model', mode: 'high' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(adapter.configurations, []);
  adapter.loadGate.resolve();
  const configured = await configuring;
  assert.equal(configured, session);
  assert.equal(configured.model, 'new-model');
  assert.equal(configured.mode, 'high');
  assert.equal(configured.modelSelectionVerified, true);
  assert.deepEqual(adapter.configurations.map(change => change.type), ['model', 'mode']);
  assert.equal(events.filter(event => event.type === 'session-updated').at(-1).session.mode, 'high');
  assert.ok(events.some(event => event.type === 'info'));
});

test('a failed mode configuration reports the model and mode the engine actually retained', async t => {
  const { controller, adapter, session } = await started(t);
  adapter.setModel = async ({ sessionId }) => {
    Object.assign(adapter.sessions.get(sessionId), { model: 'canonical-model', mode: 'medium', modes: [{ id: 'medium', name: 'Medium' }] });
  };
  adapter.setMode = async () => { throw new Error('mode rejected by Grok'); };
  await assert.rejects(controller.configureSession({ sessionId: session.id, model: 'requested-alias', mode: 'high' }), /mode rejected/);
  assert.equal(session.model, 'canonical-model');
  assert.equal(session.mode, 'medium');
  assert.equal(session.modelSelectionVerified, true);
  assert.equal(controller.operation, null);
  const saved = JSON.parse(fs.readFileSync(controller.file, 'utf8')).sessions[0];
  assert.equal(saved.model, 'canonical-model');
  assert.equal(saved.mode, 'medium');
});

test('an unverified failed model change remains unverified and releases configuration reservation', async t => {
  const { controller, adapter, session } = await started(t);
  adapter.setModel = async () => {
    adapter.sessions.get(session.id).modelSelectionVerified = false;
    throw new Error('confirmation unavailable');
  };
  await assert.rejects(controller.configureSession({ sessionId: session.id, model: 'new-model' }), /confirmation unavailable/);
  assert.equal(session.model, 'grok-test');
  assert.equal(session.modelSelectionVerified, false);
  assert.equal(controller.operation, null);
  await controller.saveSettings({ rainEnabled: false });
});

test('a failed configuration that invalidates adapter state forces restoration before the next prompt', async t => {
  const { controller, adapter, session } = await started(t);
  adapter.setModel = async () => {
    Object.assign(adapter.sessions.get(session.id), { loaded: false, modelSelectionVerified: false });
    throw new Error('configuration confirmation unavailable');
  };
  await assert.rejects(controller.configureSession({ sessionId: session.id, model: 'new-model' }), /confirmation unavailable/);
  assert.equal(controller.loaded.has(session.id), true, 'the controller has a previous successful load cached');
  assert.equal(adapter.getSession(session.id).loaded, false);
  adapter.loadResult = { model: 'server-model', mode: 'high', modes: [{ id: 'high', name: 'High' }] };
  await controller.send({ sessionId: session.id, text: 'use confirmed configuration' });
  assert.equal(adapter.loads.length, 1, 'adapter invalidation must override the controller load cache');
  assert.equal(session.model, 'server-model');
  assert.equal(session.mode, 'high');
  assert.equal(session.modelSelectionVerified, true);
  assert.equal(JSON.parse(fs.readFileSync(controller.file, 'utf8')).sessions[0].model, 'server-model');
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
});

test('a pending configuration prevents a prompt and other engine mutations from racing', async t => {
  const { controller, adapter, session } = await started(t);
  adapter.modelGate = deferred();
  const configuring = controller.configureSession({ sessionId: session.id, model: 'new-model' });
  await assert.rejects(controller.send({ sessionId: session.id, text: 'must wait' }), /更新会话配置/);
  await assert.rejects(controller.createSession(), /更新会话配置/);
  await assert.rejects(controller.reconnect(), /更新会话配置/);
  await assert.rejects(controller.saveSettings({ subagentsEnabled: false }), /更新会话配置/);
  await assert.rejects(controller.configureSession({ sessionId: session.id, mode: 'high' }), /更新会话配置/);
  assert.equal(adapter.prompts.length, 0);
  adapter.modelGate.reject(new Error('model failed'));
  await assert.rejects(configuring, /model failed/);
  assert.equal(controller.operation, null);
  await controller.send({ sessionId: session.id, text: 'now allowed' });
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
});

test('a pending creation blocks a prompt and releases its reservation if creation fails', async t => {
  const { controller, adapter, session } = await started(t);
  adapter.newGate = deferred();
  const creating = controller.createSession();
  await assert.rejects(controller.send({ sessionId: session.id, text: 'must wait' }), /创建会话/);
  adapter.newGate.reject(new Error('creation failed'));
  await assert.rejects(creating, /creation failed/);
  assert.equal(controller.sessions.length, 1);
  assert.equal(controller.operation, null);
});

test('active generation and restoration reject session configuration and engine setting changes', async t => {
  const { controller, adapter, session } = await started(t);
  controller.loaded.clear();
  adapter.loadGate = deferred();
  const sending = controller.send({ sessionId: session.id, text: 'working' });
  for (const action of [
    () => controller.configureSession({ sessionId: session.id, mode: 'high' }),
    () => controller.saveSettings({ subagentsEnabled: false }),
    () => controller.createSession(),
    () => controller.reconnect(),
  ]) await assert.rejects(action(), /当前回复/);
  adapter.loadGate.resolve();
  await sending;
  await assert.rejects(controller.configureSession({ sessionId: session.id, mode: 'high' }), /当前回复/);
  assert.deepEqual(adapter.configurations, []);
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
});

test('the subagent setting defaults to enabled, validates booleans and restarts the engine with its saved value', async t => {
  const { controller, adapter, session, instances } = await started(t);
  assert.equal(controller.settings.subagentsEnabled, true);
  assert.equal(adapter.options.subagentsEnabled, true);
  for (const value of ['false', 0, null]) await assert.rejects(controller.saveSettings({ subagentsEnabled: value }), /布尔值/);
  assert.equal(adapter.closeCount, 0);
  await controller.saveSettings({ subagentsEnabled: false });
  assert.equal(controller.settings.subagentsEnabled, false);
  assert.equal(adapter.closeCount, 1);
  assert.equal(controller.connected, false);
  assert.equal(session.modelSelectionVerified, false);
  assert.equal(controller.loaded.size, 0);
  assert.equal(JSON.parse(fs.readFileSync(controller.file, 'utf8')).settings.subagentsEnabled, false);
  await controller.reconnect();
  assert.equal(instances[1].options.subagentsEnabled, false);
  assert.equal(controller.connected, true);
  assert.equal(session.modelSelectionVerified, true);
  await controller.saveSettings({ subagentsEnabled: false });
  assert.equal(instances[1].closeCount, 0, 'saving an unchanged option must not restart the engine');
  await controller.saveSettings({ subagentsEnabled: true });
  await controller.reconnect();
  assert.equal(instances[2].options.subagentsEnabled, true);
});

test('engine shutdown for changed settings reserves the engine until complete', async t => {
  const { controller, adapter, session } = await started(t);
  adapter.closeGate = deferred();
  const saving = controller.saveSettings({ subagentsEnabled: false });
  await assert.rejects(controller.send({ sessionId: session.id, text: 'do not race shutdown' }), /保存设置/);
  await assert.rejects(controller.reconnect(), /保存设置/);
  adapter.closeGate.resolve();
  await saving;
  assert.equal(controller.operation, null);
  assert.equal(controller.settings.subagentsEnabled, false);
});

test('older or malformed atmosphere settings recover defaults without losing saved history', async t => {
  for (const settings of [{}, { rainEnabled: 'false', musicEnabled: 0, musicVolume: null }, { musicVolume: -1 }, { musicVolume: 101 }, { musicVolume: 25.5 }, { musicVolume: '25' }]) {
    const savedSession = { id: 'saved-session', title: 'Saved', cwd: 'unused', messages: [{ role: 'user', text: 'Keep this conversation' }] };
    const { controller } = fixture(t, { settings, sessions: [savedSession] });
    assert.equal(controller.settings.rainEnabled, true);
    assert.equal(controller.settings.musicEnabled, true);
    assert.equal(controller.settings.musicVolume, 90);
    assert.equal(controller.loadError, null);
    assert.equal(controller.sessions[0].messages[0].text, 'Keep this conversation');
  }
});

test('fresh installations start in English before any settings are saved', t => {
  const { controller } = fixture(t, undefined, { useAppLanguage: true });
  assert.equal(fs.existsSync(controller.file), false);
  assert.equal(controller.settings.language, 'en');
  assert.equal(controller.t('偏好设置'), 'Preferences');
});

test('supported interface languages persist across restarts without reconnecting the engine', async t => {
  const { controller, adapter, root } = await started(t, { useAppLanguage: true });
  assert.equal(controller.settings.language, 'en');
  for (const language of ['ja', 'en', 'ko', 'es', 'de', 'fr', 'zh-CN']) {
    await controller.saveSettings({ language });
    assert.equal(adapter.options.getLanguage(), language);
    assert.equal(JSON.parse(fs.readFileSync(controller.file, 'utf8')).settings.language, language);
    const reloaded = new AppController({ root, home: path.join(root, 'home'), Adapter: controller.Adapter });
    try { assert.equal(reloaded.settings.language, language); assert.equal(reloaded.loadError, null); }
    finally { await reloaded.close(); }
  }
  assert.equal(adapter.closeCount, 0);
  assert.equal(controller.connected, true);
});

test('missing or malformed saved languages recover English without losing user content', t => {
  for (const language of [undefined, null, false, 7, {}, ['en'], 'invalid', 'toString', '__proto__']) {
    const { controller } = fixture(t, { settings: { language }, sessions: [{ id: 'kept', title: 'User title', cwd: 'unused', messages: [{ role: 'user', text: 'Do not translate this' }] }] }, { useAppLanguage: true });
    assert.equal(controller.settings.language, 'en');
    assert.equal(controller.loadError, null);
    assert.equal(controller.sessions[0].title, 'User title');
    assert.equal(controller.sessions[0].messages[0].text, 'Do not translate this');
  }
});

test('invalid language patches are atomic and a failed language save restores the active locale', async t => {
  const { controller, adapter } = await started(t);
  const before = structuredClone(controller.settings);
  const saved = fs.readFileSync(controller.file, 'utf8');
  for (const language of [null, false, 7, {}, ['en'], 'invalid', 'toString', '__proto__']) {
    await assert.rejects(controller.saveSettings({ rainEnabled: false, language }), /界面语言/);
  }
  const save = controller.save;
  controller.save = () => { throw new Error('fixture disk unavailable'); };
  try { await assert.rejects(controller.saveSettings({ language: 'de' }), /fixture disk unavailable/); }
  finally { controller.save = save; }
  assert.deepEqual(controller.settings, before);
  assert.equal(adapter.options.getLanguage(), 'zh-CN');
  assert.equal(fs.readFileSync(controller.file, 'utf8'), saved);
  assert.equal(adapter.closeCount, 0);
});

test('switching interface language mid-reply keeps the active turn, stream and model unchanged', async t => {
  const { controller, adapter, session, instances } = await started(t);
  await controller.send({ sessionId: session.id, text: 'Keep this user message' });
  adapter.emit('event', { type: 'text', sessionId: session.id, text: 'Stream before ' });
  const active = controller.active;
  for (const language of ['ja', 'en', 'ko', 'es', 'de', 'fr', 'zh-CN']) {
    const saved = await controller.saveSettings({ language });
    assert.equal(saved.language, language);
    assert.equal(controller.active, active);
    assert.equal(active.message.status, 'working');
    assert.equal(controller.connected, true);
    assert.equal(session.modelSelectionVerified, true);
    assert.equal(adapter.closeCount, 0);
  }
  adapter.emit('event', { type: 'text', sessionId: session.id, text: 'and after' });
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
  assert.equal(instances.length, 1);
  assert.equal(session.messages[0].text, 'Keep this user message');
  assert.equal(session.messages[1].text, 'Stream before and after');
});

test('default labels are marked for translation while explicitly renamed defaults remain user content', async t => {
  const { controller, session, adapter, root } = await started(t);
  assert.equal(session.titleIsDefault, true);
  assert.equal(controller.accountState().accounts[0].nameIsDefault, true);
  controller.renameSession({ sessionId: session.id, title: '新会话' });
  await controller.renameAccount('local', '本机 Grok 账户');
  assert.equal(session.titleIsDefault, false);
  assert.equal(controller.accountState().accounts[0].nameIsDefault, false);
  await controller.saveSettings({ language: 'en' });
  await controller.send({ sessionId: session.id, text: 'Keep the explicitly chosen title' });
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
  assert.equal(controller.sessionTitle(session), '新会话');
  const reloaded = new AppController({ root, home: path.join(root, 'home'), Adapter: controller.Adapter });
  try {
    assert.equal(reloaded.sessions[0].title, '新会话');
    assert.equal(reloaded.sessions[0].titleIsDefault, false);
    assert.equal(reloaded.accountState().accounts[0].nameIsDefault, false);
  } finally { await reloaded.close(); }
});

test('Markdown export localizes generated labels while preserving authored text and explicit image descriptions', async t => {
  const { controller, session } = await started(t);
  controller.t = (source, params = {}) => ({ '新会话': 'New chat', '你': 'You', '错误：': 'Error: ', '图片': 'Image', 'Grok 返回的图片': 'Image returned by Grok', '工作目录：{path}': `Working directory: ${params.path}` })[source] || source;
  session.messages.push({ role: 'user', text: '保留作者原文 {name}', images: [
    { src: 'https://example.test/generated.png', alt: 'Grok 返回的图片', altIsDefault: true },
    { src: 'https://example.test/authored.png', alt: 'Grok 返回的图片', altIsDefault: false },
  ] });
  const exported = controller.exportMarkdown(session.id);
  assert.ok(exported.startsWith('# New chat\n\nWorking directory: '));
  assert.ok(exported.includes('## You\n\n保留作者原文 {name}'));
  assert.ok(exported.includes('![Image returned by Grok](<https://example.test/generated.png>)'));
  assert.ok(exported.includes('![Grok 返回的图片](<https://example.test/authored.png>)'));
  controller.renameSession({ sessionId: session.id, title: '新会话' });
  assert.ok(controller.exportMarkdown(session.id).startsWith('# 新会话\n'));
});

test('image validation receives the active controller translator without changing image source content', async t => {
  const { controller, session } = await started(t);
  controller.t = source => source === '不支持的图片地址' ? 'Unsupported image address' : source;
  await assert.rejects(controller.readImage({ sessionId: session.id, src: 'javascript:invalid' }), /Unsupported image address/);
  assert.deepEqual(await controller.readImage({ sessionId: session.id, src: 'https://example.test/raw-image.png' }), { src: 'https://example.test/raw-image.png' });
});

test('invalid atmosphere patches reject atomically and leave saved settings and the engine intact', async t => {
  const { controller, adapter } = await started(t);
  const before = structuredClone(controller.settings);
  const saved = fs.readFileSync(controller.file, 'utf8');
  for (const value of ['false', 0, null, {}]) {
    await assert.rejects(controller.saveSettings({ rainEnabled: false, musicEnabled: value, musicVolume: 50 }), /布尔值/);
  }
  for (const value of [-1, 101, 25.5, NaN, Infinity, -Infinity, '25', null, true]) {
    await assert.rejects(controller.saveSettings({ rainEnabled: false, musicEnabled: false, musicVolume: value }), /0 到 100 的整数/);
  }
  assert.deepEqual(controller.settings, before);
  assert.equal(fs.readFileSync(controller.file, 'utf8'), saved);
  assert.equal(adapter.closeCount, 0);
  assert.equal(controller.connected, true);
});

test('music and rain preferences persist across reloads including mute and maximum volume', async t => {
  const { controller, adapter, root } = await started(t);
  assert.equal(controller.settings.musicEnabled, true);
  assert.equal(controller.settings.musicVolume, 90);
  for (const preferences of [
    { rainEnabled: false, musicEnabled: false, musicVolume: 0 },
    { rainEnabled: true, musicEnabled: true, musicVolume: 100 },
  ]) {
    await controller.saveSettings(preferences);
    const reloaded = new AppController({ root, home: path.join(root, 'home'), Adapter: controller.Adapter });
    for (const [key, value] of Object.entries(preferences)) assert.equal(reloaded.settings[key], value);
    assert.equal(reloaded.loadError, null);
    await reloaded.close();
  }
  assert.equal(adapter.closeCount, 0);
});

test('atmosphere settings can be saved during generation without changing the running engine', async t => {
  const { controller, adapter, session } = await started(t);
  await controller.send({ sessionId: session.id, text: 'keep working' });
  const active = controller.active;
  const settings = await controller.saveSettings({ ...controller.settings, rainEnabled: false, musicEnabled: false, musicVolume: 0 });
  assert.equal(settings.rainEnabled, false);
  assert.equal(settings.musicEnabled, false);
  assert.equal(settings.musicVolume, 0);
  assert.equal(controller.active, active);
  assert.equal(controller.active.message.status, 'working');
  assert.equal(adapter.closeCount, 0);
  assert.equal(controller.connected, true);
  assert.equal(session.modelSelectionVerified, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(controller.file, 'utf8')).settings, settings);
  await controller.saveSettings({ musicEnabled: true, musicVolume: 40 });
  assert.equal(controller.active, active);
  assert.equal(adapter.prompts.length, 1);
  assert.equal(adapter.closeCount, 0);
  await assert.rejects(controller.saveSettings({ rainEnabled: 'false' }), /布尔值/);
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
});

test('path settings reject missing folders and executable directories without changing saved settings', async t => {
  const { controller, adapter, root } = await started(t);
  const before = structuredClone(controller.settings);
  const directory = path.join(root, 'directory.exe');
  fs.mkdirSync(directory);
  await assert.rejects(controller.saveSettings({ executable: directory }), /有效的 grok.exe/);
  await assert.rejects(controller.saveSettings({ workspace: path.join(root, 'missing') }), /有效的工作目录/);
  await assert.rejects(controller.createSession({ cwd: path.join(root, 'missing') }), /有效的工作目录/);
  await assert.rejects(controller.createSession({ cwd: 'relative-folder' }), /有效的工作目录/);
  assert.deepEqual(controller.settings, before);
  assert.equal(adapter.closeCount, 0);
});

test('a failed settings write preserves the settings that were actually saved', async t => {
  const { controller, adapter } = await started(t);
  const before = structuredClone(controller.settings);
  const saved = fs.readFileSync(controller.file, 'utf8');
  const save = controller.save.bind(controller);
  controller.save = () => { throw new Error('disk unavailable'); };
  await assert.rejects(controller.saveSettings({ rainEnabled: false, musicEnabled: false, musicVolume: 0 }), /disk unavailable/);
  controller.save = save;
  assert.deepEqual(controller.settings, before);
  assert.equal(controller.operation, null);
  assert.equal(adapter.closeCount, 0);
  assert.equal(fs.readFileSync(controller.file, 'utf8'), saved);
});

test('a failed initial message write releases send controls and avoids duplicating unsent history', async t => {
  const { controller, adapter, session } = await started(t);
  const save = controller.save.bind(controller);
  let saves = 0;
  controller.save = () => { if (++saves === 2) throw new Error('disk unavailable'); save(); };
  await assert.rejects(controller.send({ sessionId: session.id, text: 'not sent' }), /消息尚未发送/);
  controller.save = save;
  assert.equal(controller.active, null);
  assert.equal(session.messages.length, 0);
  assert.equal(session.title, '新会话');
  assert.equal(adapter.prompts.length, 0);
  await controller.send({ sessionId: session.id, text: 'retry once' });
  assert.equal(session.messages.length, 2);
  assert.equal(adapter.prompts.length, 1);
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
});

test('a final transcript write failure still publishes completion and releases the next turn', async t => {
  const { controller, adapter, session } = await started(t);
  const events = [];
  controller.on('event', event => events.push(event));
  await controller.send({ sessionId: session.id, text: 'finish the answer' });
  const save = controller.save.bind(controller);
  controller.save = () => { throw new Error('disk unavailable'); };
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
  controller.save = save;
  assert.equal(controller.active, null);
  assert.equal(session.messages[1].status, 'complete');
  assert.ok(events.some(event => event.type === 'error' && /保存失败/.test(event.message)));
  assert.ok(events.some(event => event.type === 'status' && event.status === 'idle'));
  await controller.send({ sessionId: session.id, text: 'next answer' });
  adapter.prompts[1].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
});

test('stopping the first restore before an adapter exists prevents a prompt without failing', async t => {
  const { controller, instances } = fixture(t, { settings: {}, sessions: [{ id: 'old', title: 'Saved', cwd: 'unused', messages: [] }] });
  const session = controller.sessions[0];
  session.cwd = controller.settings.workspace;
  const connect = controller._connect.bind(controller);
  const gate = deferred();
  controller._connect = async () => { await gate.promise; return connect(); };
  const sending = controller.send({ sessionId: session.id, text: 'do not start' });
  assert.equal(controller.adapter, undefined);
  assert.deepEqual(await controller.cancel(session.id), { cancelled: true });
  gate.resolve();
  assert.deepEqual(await sending, { accepted: false, cancelled: true });
  assert.equal(instances[0].prompts.length, 0);
  assert.equal(controller.active, null);
});

test('a rejected stop request does not falsely mark a running response cancelled', async t => {
  const { controller, adapter, session } = await started(t);
  await controller.send({ sessionId: session.id, text: 'answer' });
  adapter.cancel = async () => { throw new Error('cancel was not sent'); };
  await assert.rejects(controller.cancel(session.id), /cancel was not sent/);
  assert.equal(controller.active.cancelled, false);
  assert.equal(session.messages[1].status, 'working');
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
  assert.equal(session.messages[1].status, 'complete');
});

test('resolved permission events invalidate controls and duplicate permission submissions are rejected', async t => {
  const { controller, adapter, session } = await started(t);
  const permission = { type: 'permission', sessionId: session.id, requestId: '42', options: [{ optionId: 'allow-once' }] };
  adapter.emit('event', { ...permission });
  adapter.emit('event', { type: 'status', status: 'permission_resolved', requestId: '42', sessionId: session.id });
  await assert.rejects(controller.permission({ requestId: '42', optionId: 'allow-once' }), /授权/);
  const gate = deferred();
  adapter.respondPermission = async args => { adapter.responses.push(args); await gate.promise; };
  adapter.emit('event', { ...permission });
  const first = controller.permission({ requestId: '42', optionId: 'allow-once' });
  await assert.rejects(controller.permission({ requestId: '42', optionId: 'allow-once' }), /授权/);
  gate.resolve();
  await first;
  assert.equal(adapter.responses.length, 1);
});

test('a failed permission submission remains retryable until the engine resolves it', async t => {
  const { controller, adapter, session } = await started(t);
  adapter.emit('event', { type: 'permission', sessionId: session.id, requestId: '42', options: [{ optionId: 'reject' }] });
  adapter.respondPermission = async () => { throw new Error('transport unavailable'); };
  await assert.rejects(controller.permission({ requestId: '42', optionId: 'reject' }), /transport unavailable/);
  adapter.respondPermission = async args => adapter.responses.push(args);
  await controller.permission({ requestId: '42', optionId: 'reject' });
  assert.equal(adapter.responses.length, 1);
  assert.equal(controller.permissions.size, 0);
});

test('reconnect remains connected when an old conversation cannot be restored', async t => {
  const { controller, instances, session } = await started(t);
  const originalLoad = controller.Adapter.prototype.loadSession;
  controller.Adapter.prototype.loadSession = async () => { throw new Error('old workspace is missing'); };
  const events = [];
  controller.on('event', event => events.push(event));
  const info = await controller.reconnect();
  controller.Adapter.prototype.loadSession = originalLoad;
  assert.equal(controller.connected, true);
  assert.equal(session.modelSelectionVerified, false);
  assert.equal(info.models[0].id, 'grok-test');
  assert.equal(instances.length, 2);
  assert.ok(events.some(event => event.type === 'error' && event.sessionId === session.id && /old workspace/.test(event.message)));
});

test('bootstrap and reconnect recover model choices using a new default-directory session when stale history fails', async t => {
  for (const method of ['bootstrap', 'reconnect']) {
    await t.test(method, async t => {
      const { controller, instances } = fixture(t, { settings: {}, sessions: [{ id: 'old', title: 'Saved', cwd: 'missing-folder', messages: [] }] });
      const originalStart = controller.Adapter.prototype.start;
      const originalNew = controller.Adapter.prototype.newSession;
      controller.Adapter.prototype.start = async function () { this.info.models = []; return originalStart.call(this); };
      controller.Adapter.prototype.loadSession = async () => { throw new Error('old workspace is missing'); };
      controller.Adapter.prototype.newSession = async function () { this.info.models = [{ id: 'grok-test', name: 'Grok Test' }]; return originalNew.call(this); };
      const events = [];
      controller.on('event', event => events.push(event));
      await controller[method]();
      assert.equal(controller.connected, true);
      assert.equal(controller.sessions.length, 2);
      assert.equal(controller.sessions[0].cwd, controller.settings.workspace);
      assert.equal(controller.normalizeInfo().models[0].id, 'grok-test');
      assert.ok(events.some(event => event.type === 'session-updated' && event.session.id !== 'old'));
      assert.equal(instances[0].prompts.length, 0);
    });
  }
});

test('stream events for another session never create a phantom reply in the UI', async t => {
  const { controller, adapter, session } = await started(t);
  const other = await controller.createSession();
  const events = [];
  controller.on('event', event => events.push(event));
  await controller.send({ sessionId: session.id, text: 'current question' });
  for (const type of ['text', 'thought', 'tool']) adapter.emit('event', { type, sessionId: other.id, text: 'late output', toolCallId: 'old' });
  assert.equal(events.filter(event => ['text', 'thought', 'tool'].includes(event.type)).length, 0);
  assert.equal(other.messages.length, 0);
  assert.equal(session.messages[1].text, '');
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
});

test('failed history writes leave rename, delete and create actions safe to retry', async t => {
  const { controller, session } = await started(t);
  const save = controller.save.bind(controller);
  controller.save = () => { throw new Error('disk unavailable'); };
  assert.throws(() => controller.renameSession({ sessionId: session.id, title: 'new title' }), /disk unavailable/);
  assert.equal(session.title, '新会话');
  assert.throws(() => controller.deleteSession(session.id), /disk unavailable/);
  assert.equal(controller.getSession(session.id), session);
  assert.equal(controller.loaded.has(session.id), true);
  await assert.rejects(controller.createSession(), /disk unavailable/);
  assert.deepEqual(controller.sessions, [session]);
  assert.deepEqual([...controller.loaded], [session.id]);
  controller.save = save;
  controller.renameSession({ sessionId: session.id, title: 'saved title' });
  assert.equal(controller.getSession(session.id).title, 'saved title');
  assert.equal(controller.deleteSession(session.id), true);
  assert.deepEqual(controller.sessions, []);
});

test('per-session model menus are saved independently of the global engine selection', async t => {
  const { controller, adapter, session } = await started(t);
  adapter.sessions.get(session.id).models = [{ id: 'grok-session', name: 'Session model' }];
  adapter.info.models = [{ id: 'grok-other', name: 'Other model' }];
  await controller.selectSession(session.id);
  assert.deepEqual(session.models, [{ id: 'grok-session', name: 'Session model' }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(controller.file, 'utf8')).sessions[0].models, session.models);
});

test('closing still stops the engine and releases an active turn when the final save fails', async t => {
  const { controller, adapter, session } = await started(t);
  await controller.send({ sessionId: session.id, text: 'running at shutdown' });
  const save = controller.save.bind(controller);
  controller.save = () => { throw new Error('disk unavailable'); };
  await assert.rejects(controller.close(), /disk unavailable/);
  controller.save = save;
  assert.equal(adapter.closeCount, 1);
  assert.equal(controller.active, null);
  assert.equal(session.messages[1].status, 'cancelled');
  assert.equal(controller.closing, true);
});

test('account switching isolates sessions, credentials and stale engine events across restart', async t => {
  const { controller, session, adapter, root } = await started(t);
  controller.renameSession({ sessionId: session.id, title: 'Local history' });
  const account = await controller.addAccount({ name: 'Work' }); signIn(controller, account);
  const switched = await controller.switchAccount(account.id);
  assert.equal(adapter.closeCount, 1);
  assert.equal(switched.sessions.length, 1); assert.equal(switched.sessions[0].accountId, account.id);
  assert.equal(controller.adapter.options.env.GROK_HOME, controller.accountManager.homeFor(account.id));
  assert.throws(() => controller.getSession(session.id), /其他账户/);
  await assert.rejects(controller.send({ sessionId: session.id, text: 'wrong account' }), /其他账户/);
  const events = []; controller.on('event', event => events.push(event));
  adapter.emit('event', { type: 'text', sessionId: session.id, text: 'stale engine' });
  assert.equal(events.length, 0);
  const workSession = switched.sessions[0];
  const restored = await controller.switchAccount('local');
  assert.equal(restored.sessions[0].title, 'Local history'); assert.equal(restored.sessions[0].id, session.id);
  assert.equal(restored.sessions.some(s => s.id === workSession.id), false);
  assert.equal(JSON.parse(fs.readFileSync(controller.file, 'utf8')).sessions.length, 2);
  await controller.switchAccount(account.id);
  const next = new AppController({ root, home: path.join(root, 'home'), Adapter: controller.Adapter });
  try {
    const boot = await next.bootstrap(); assert.equal(boot.activeAccountId, account.id);
    assert.deepEqual(boot.sessions.map(s => s.id), [workSession.id]);
  } finally { await next.close(); }
});

test('unsigned accounts remain offline, while busy turns and failed saves cannot switch accounts', async t => {
  const { controller, session, adapter } = await started(t);
  const account = await controller.addAccount({ name: 'Unlogged' });
  await controller.send({ sessionId: session.id, text: 'working' });
  await assert.rejects(controller.switchAccount(account.id), /等待/);
  await assert.rejects(controller.loginAccount('local'), /等待/);
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' }); await controller.turnPromise;
  const save = controller.save.bind(controller); controller.save = () => { throw new Error('disk unavailable'); };
  await assert.rejects(controller.switchAccount(account.id), /disk unavailable/); assert.equal(controller.activeAccountId, 'local');
  await assert.rejects(controller.addAccount({ name: 'Unsaved' }), /disk unavailable/); assert.equal(controller.accounts.length, 2);
  controller.save = save;
  const offline = await controller.switchAccount(account.id);
  assert.equal(offline.connected, false); assert.equal(offline.sessions.length, 0); assert.match(offline.error, /登录/);
  const restored = await controller.switchAccount('local'); assert.equal(restored.connected, true); assert.equal(restored.sessions[0].id, session.id);
});

test('image chunks and tool images persist once, survive reload and appear in Markdown export', async t => {
  const { controller, session, adapter } = await started(t);
  const png = fs.readFileSync(path.resolve(__dirname, '../src/renderer/assets/icon.png')).toString('base64');
  const image = { src: `data:image/png;base64,${png}`, alt: 'Preview' };
  await controller.send({ sessionId: session.id, text: 'show image' });
  adapter.emit('event', { type: 'image', sessionId: session.id, image });
  adapter.emit('event', { type: 'image', sessionId: session.id, image, replay: true });
  adapter.emit('event', { type: 'image', sessionId: 'another-session', image: { src: 'wrong' } });
  adapter.emit('event', { type: 'tool', sessionId: session.id, toolCallId: 'image-tool', content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: png } }] });
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' }); await controller.turnPromise;
  const stored = JSON.parse(fs.readFileSync(controller.file, 'utf8')).sessions[0].messages.at(-1);
  assert.equal(stored.images.length, 1); assert.deepEqual(stored.images[0], { ...image, origin: 'assistant' });
  assert.ok(controller.exportMarkdown(session.id).includes('![Preview](<data:image/png;base64,'));
  assert.equal((await controller.readImage({ sessionId: session.id, src: image.src })).src, image.src);
});

test('reading an uploaded image never echoes it into the streamed or saved reply', async t => {
  const { controller, session, adapter } = await started(t);
  const bytes = fs.readFileSync(path.resolve(__dirname, '../src/renderer/assets/icon.png'));
  const [attachment] = await controller.importAttachments({ files: [{ name: 'input.png', data: bytes.toString('base64') }] });
  const events = []; controller.on('event', event => events.push(event));
  await controller.send({ sessionId: session.id, text: 'Describe the image', attachments: [attachment.id] });
  const content = [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') } }];
  const emit = update => adapter.emit('event', { type: 'tool', sessionId: session.id, toolCallId: 'read-input', ...update });
  emit({ title: 'read_file', kind: 'other', status: 'pending', rawInput: { target_file: attachment.src } });
  emit({ title: `Read \`${attachment.src}\``, kind: 'read', status: 'in_progress', rawInput: { variant: 'ReadFile', target_file: attachment.src } });
  emit({ status: 'completed', content });
  emit({ status: 'completed' });
  adapter.emit('event', { type: 'text', sessionId: session.id, text: 'An illustrated city.' });
  assert.equal(events.filter(event => event.type === 'image').length, 0);
  assert.equal(session.messages[0].images.length, 1);
  assert.deepEqual(session.messages[1].images, []);
  assert.equal(session.messages[1].tools[0].content[0].content.type, 'image');
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' }); await controller.turnPromise;
  const restored = new AppController({ root: controller.root, home: controller.root });
  t.after(() => clearTimeout(restored.saveTimer));
  assert.deepEqual(restored.sessions[0].messages[1].images, []);
  assert.equal((restored.exportMarkdown(session.id).match(/!\[/g) || []).length, 1, 'only the user upload is exported');
});

test('generated tool images stream once even when partial status updates follow', async t => {
  const { controller, session, adapter } = await started(t);
  const data = fs.readFileSync(path.resolve(__dirname, '../src/renderer/assets/icon.png')).toString('base64');
  const events = []; controller.on('event', event => events.push(event));
  await controller.send({ sessionId: session.id, text: 'Generate an image' });
  for (const update of [
    { title: 'Generate image', kind: 'execute', status: 'in_progress' },
    { status: 'completed', content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data } }] },
    { status: 'completed' },
  ]) adapter.emit('event', { type: 'tool', sessionId: session.id, toolCallId: 'generate', ...update });
  assert.equal(events.filter(event => event.type === 'image').length, 1);
  assert.equal(session.messages[1].images.length, 1);
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' }); await controller.turnPromise;
});

test('legacy saved tool images become visible and historical records migrate to the local account', t => {
  const data = { type: 'image', mimeType: 'image/png', data: fs.readFileSync(path.resolve(__dirname, '../src/renderer/assets/icon.png')).toString('base64') };
  const { controller } = fixture(t, { version: 1, settings: {}, sessions: [{ id: 'old', title: 'Old image', cwd: process.cwd(), messages: [{ role: 'assistant', text: 'An image', tools: [{ content: [{ type: 'content', content: data }] }] }] }] });
  assert.equal(controller.visibleSessions()[0].accountId, 'local');
  assert.equal(controller.visibleSessions()[0].messages[0].images.length, 1);
  assert.ok(controller.exportMarkdown('old').includes('data:image/png;base64,'));
});

test('account names are trimmed, unique across casing and width, and rename returns a complete snapshot', async t => {
  const { controller, session } = await started(t);
  const account = await controller.addAccount({ name: '  Work  ' });
  assert.equal(account.name, 'Work');
  for (const name of ['', '   ', 'x'.repeat(61), null]) await assert.rejects(controller.renameAccount(account.id, name), /1 到 60/);
  await assert.rejects(controller.addAccount({ name: 'ｗｏｒｋ' }), /同名/);
  await assert.rejects(controller.renameAccount('local', 'WORK'), /同名/);
  await assert.rejects(controller.renameAccount('unknown', 'New'), /不存在/);
  const state = await controller.renameAccount(account.id, '  Personal  ');
  assert.equal(state.accounts.find(a => a.id === account.id).name, 'Personal');
  assert.equal(state.activeAccountId, 'local');
  assert.deepEqual(state.sessions, [session]);
  assert.equal(state.error, null);
  assert.equal(JSON.parse(fs.readFileSync(controller.file, 'utf8')).accounts[1].name, 'Personal');
  await controller.renameAccount(account.id, 'Personal');
});

test('failed account renames roll back in memory and on disk and remain retryable', async t => {
  const { controller } = fixture(t);
  const account = await controller.addAccount({ name: 'Work' });
  const saved = fs.readFileSync(controller.file, 'utf8');
  const save = controller.save.bind(controller);
  controller.save = () => { throw new Error('disk unavailable'); };
  try { await assert.rejects(controller.renameAccount(account.id, 'Changed'), /disk unavailable/); }
  finally { controller.save = save; }
  assert.equal(controller.accounts[1].name, 'Work');
  assert.equal(fs.readFileSync(controller.file, 'utf8'), saved);
  assert.equal((await controller.renameAccount(account.id, 'Changed')).accounts[1].name, 'Changed');
});

test('deleting an inactive profile removes its credentials, cache and conversations while preserving local data', async t => {
  const { controller, session, adapter } = await started(t);
  const account = await controller.addAccount({ name: 'Work' });
  signIn(controller, account);
  const profile = controller.accountManager.profileDirectory(account.id);
  fs.mkdirSync(path.join(profile, 'grok', 'sessions', 'cached'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'grok', 'sessions', 'cached', 'image.png'), 'test cache');
  const localMarker = path.join(controller.accountManager.homeFor('local'), 'keep.txt');
  fs.writeFileSync(localMarker, 'local account data');
  controller.sessions.push({ id: 'profile-history', accountId: account.id, title: 'Profile chat', cwd: controller.settings.workspace, messages: [{ role: 'user', text: 'private profile fixture' }] });
  controller.save();
  const state = await controller.deleteAccount(account.id);
  assert.deepEqual(state.accounts.map(a => a.id), ['local']);
  assert.equal(state.activeAccountId, 'local');
  assert.equal(state.connected, true);
  assert.equal(state.error, null);
  assert.deepEqual(state.sessions, [session]);
  assert.equal(adapter.closeCount, 0, 'deleting an inactive account must not interrupt the active engine');
  assert.equal(fs.existsSync(profile), false);
  assert.equal(fs.existsSync(controller.accountManager.profileDirectory(account.id, true)), false);
  assert.equal(fs.readFileSync(localMarker, 'utf8'), 'local account data');
  assert.ok(!fs.readFileSync(controller.file, 'utf8').includes('private profile fixture'));
  await assert.rejects(controller.deleteAccount('local'), /不能删除/);
  await assert.rejects(controller.deleteAccount(account.id), /不存在/);
});

test('deleting the active account succeeds offline and switches history to local even if reconnect fails', async t => {
  const { controller, session } = await started(t);
  const account = await controller.addAccount({ name: 'Work' });
  signIn(controller, account);
  const workState = await controller.switchAccount(account.id);
  const workAdapter = controller.adapter;
  controller.settings.executable = path.join(controller.root, 'missing.exe');
  controller.connected = false;
  const events = [];
  controller.on('event', event => events.push(structuredClone(event)));
  const state = await controller.deleteAccount(account.id);
  assert.equal(workAdapter.closeCount, 1);
  assert.equal(state.activeAccountId, 'local');
  assert.equal(state.connected, false);
  assert.match(state.error, /账户已移除/);
  assert.deepEqual(state.sessions.map(s => s.id), [session.id]);
  assert.equal(controller.sessions.some(s => s.id === workState.sessions[0].id), false);
  assert.equal(events.find(e => e.type === 'account-changed').state.activeAccountId, 'local');
  assert.equal(JSON.parse(fs.readFileSync(controller.file, 'utf8')).activeAccountId, 'local');
  assert.equal(fs.existsSync(controller.accountManager.profileDirectory(account.id)), false);
});

test('an unsigned profile without any directory can be deleted without connecting to Grok', async t => {
  const { controller, instances } = fixture(t);
  const account = await controller.addAccount({ name: 'Unused' });
  const state = await controller.deleteAccount(account.id);
  assert.deepEqual(state.accounts.map(a => a.id), ['local']);
  assert.equal(instances.length, 0);
  assert.equal(state.error, null);
});

test('failed account deletion saves restore credentials, sessions and active account before retry', async t => {
  const { controller } = await started(t);
  const account = await controller.addAccount({ name: 'Work' }); signIn(controller, account);
  await controller.switchAccount(account.id);
  const sessions = controller.sessions;
  const saved = fs.readFileSync(controller.file, 'utf8');
  const save = controller.save.bind(controller);
  controller.save = () => { throw new Error('disk unavailable'); };
  try { await assert.rejects(controller.deleteAccount(account.id), /disk unavailable/); }
  finally { controller.save = save; }
  assert.equal(controller.activeAccountId, account.id);
  assert.equal(controller.sessions, sessions);
  assert.equal(controller.accounts.some(a => a.id === account.id), true);
  assert.equal(controller.accountManager.summary(account).signedIn, true);
  assert.equal(fs.existsSync(controller.accountManager.profileDirectory(account.id, true)), false);
  assert.equal(fs.readFileSync(controller.file, 'utf8'), saved);
  assert.equal((await controller.deleteAccount(account.id)).activeAccountId, 'local');
});

test('directory move failure does not remove the account or its history', async t => {
  const { controller } = fixture(t);
  const account = await controller.addAccount({ name: 'Work' }); signIn(controller, account);
  const stage = controller.accountManager.stageDelete.bind(controller.accountManager);
  controller.accountManager.stageDelete = () => { throw new Error('directory locked'); };
  try { await assert.rejects(controller.deleteAccount(account.id), /directory locked/); }
  finally { controller.accountManager.stageDelete = stage; }
  assert.equal(controller.accounts.some(a => a.id === account.id), true);
  assert.equal(controller.accountManager.summary(account).signedIn, true);
  await controller.deleteAccount(account.id);
});

test('unfinished directory deletion is retried after restart without resurrecting the removed account', async t => {
  const { controller, root } = fixture(t);
  const account = await controller.addAccount({ name: 'Work' }); signIn(controller, account);
  const finish = controller.accountManager.completeDelete.bind(controller.accountManager);
  controller.accountManager.completeDelete = () => { throw new Error('cache locked'); };
  let state;
  try { state = await controller.deleteAccount(account.id); }
  finally { controller.accountManager.completeDelete = finish; }
  assert.equal(state.accounts.some(a => a.id === account.id), false);
  assert.match(state.error, /已移除.*尚未完全清理/);
  assert.equal(fs.existsSync(controller.accountManager.profileDirectory(account.id, true)), true);
  const next = new AppController({ root, home: path.join(root, 'home'), Adapter: controller.Adapter });
  try {
    assert.equal(next.accounts.some(a => a.id === account.id), false);
    assert.equal(fs.existsSync(next.accountManager.profileDirectory(account.id, true)), false);
  } finally { await next.close(); }
});

test('restart restores an account directory when a staged deletion never committed', async t => {
  const { controller, root } = fixture(t);
  const account = await controller.addAccount({ name: 'Work' }); signIn(controller, account);
  controller.accountManager.stageDelete(account.id);
  const next = new AppController({ root, home: path.join(root, 'home'), Adapter: controller.Adapter });
  try {
    assert.equal(next.accounts.some(a => a.id === account.id), true);
    assert.equal(next.accountManager.summary(account).signedIn, true);
    assert.equal(fs.existsSync(next.accountManager.profileDirectory(account.id, true)), false);
  } finally { await next.close(); }
});

test('failed rollback keeps the original credentials recoverable and prevents login overwriting them', async t => {
  const { controller, root } = fixture(t);
  const account = await controller.addAccount({ name: 'Work' }); signIn(controller, account);
  const save = controller.save.bind(controller);
  const restore = controller.accountManager.restoreDelete.bind(controller.accountManager);
  controller.save = () => { throw new Error('disk unavailable'); };
  controller.accountManager.restoreDelete = () => { throw new Error('directory locked'); };
  try { await assert.rejects(controller.deleteAccount(account.id), /本地数据已保留/); }
  finally { controller.save = save; controller.accountManager.restoreDelete = restore; }
  assert.equal(controller.accounts.some(a => a.id === account.id), true);
  await assert.rejects(controller.loginAccount(account.id), /尚未恢复/);
  assert.equal(fs.existsSync(controller.accountManager.profileDirectory(account.id)), false);
  const next = new AppController({ root, home: path.join(root, 'home'), Adapter: controller.Adapter });
  try { assert.equal(next.accountManager.summary(account).signedIn, true); }
  finally { await next.close(); }
});

test('unreadable history permanently quarantines staged credentials across close and another restart', async t => {
  const { controller, root } = fixture(t);
  const account = await controller.addAccount({ name: 'Work' }); signIn(controller, account);
  controller.accountManager.stageDelete(account.id);
  fs.writeFileSync(controller.file, '{broken');
  const next = new AppController({ root, home: path.join(root, 'home'), Adapter: controller.Adapter });
  try {
    assert.match(next.loadError, /backup/);
    assert.equal(fs.existsSync(next.accountManager.profileDirectory(account.id, true)), false);
    assert.equal(fs.existsSync(next.accountManager.recoveryDirectory(account.id)), true);
  } finally { await next.close(); }
  const restarted = new AppController({ root, home: path.join(root, 'home'), Adapter: controller.Adapter });
  try {
    assert.equal(restarted.accounts.some(a => a.id === account.id), false);
    assert.equal(fs.existsSync(path.join(restarted.accountManager.recoveryDirectory(account.id), 'grok', 'auth.json')), true);
  } finally { await restarted.close(); }
});

test('failed quarantine blocks saving reset history until staged credentials can be preserved', async t => {
  const { controller, root } = fixture(t);
  const account = await controller.addAccount({ name: 'Work' }); signIn(controller, account);
  controller.accountManager.stageDelete(account.id);
  fs.writeFileSync(controller.file, '{broken');
  class LockedAccounts extends controller.accountManager.constructor {
    preserveUnverifiedDeletes() { throw new Error('directory locked'); }
  }
  const locked = new AppController({ root, home: path.join(root, 'home'), Adapter: controller.Adapter, Accounts: LockedAccounts });
  assert.match(locked.loadError, /Could not isolate/);
  assert.throws(() => locked.save(), /history file was not overwritten/);
  await assert.rejects(locked.close(), /history file was not overwritten/);
  assert.equal(fs.readFileSync(controller.file, 'utf8'), '{broken');
  assert.equal(fs.existsSync(locked.accountManager.profileDirectory(account.id, true)), true);
  const recovered = new AppController({ root, home: path.join(root, 'home'), Adapter: controller.Adapter });
  try { assert.equal(fs.existsSync(recovered.accountManager.recoveryDirectory(account.id)), true); }
  finally { await recovered.close(); }
});

test('closing while login waits for the old engine cannot launch an orphan login process', async t => {
  const { controller, adapter } = await started(t);
  let spawns = 0;
  controller.accountManager.spawnProcess = () => { spawns++; throw new Error('login should not spawn'); };
  adapter.closeGate = deferred();
  const login = controller.loginAccount('local');
  await new Promise(resolve => setImmediate(resolve));
  const closing = controller.close();
  const rejected = assert.rejects(login, /应用正在关闭/);
  adapter.closeGate.resolve();
  await rejected;
  await closing;
  assert.equal(spawns, 0);
  assert.equal(controller.accountManager.pending, null);
});

test('account mutations reject generation, pending login and a concurrent engine operation', async t => {
  const { controller, session, adapter } = await started(t);
  const account = await controller.addAccount({ name: 'Work' });
  const mutations = () => [() => controller.addAccount({ name: 'New' }), () => controller.renameAccount(account.id, 'New'), () => controller.deleteAccount(account.id)];
  await controller.send({ sessionId: session.id, text: 'working' });
  for (const mutation of mutations()) await assert.rejects(mutation(), /等待/);
  adapter.prompts[0].gate.resolve({ stopReason: 'end_turn' }); await controller.turnPromise;
  controller.accountManager.pending = { accountId: 'local', status: 'waiting' };
  try { for (const mutation of mutations()) await assert.rejects(mutation(), /登录/); }
  finally { controller.accountManager.pending = null; }
  const gate = deferred();
  const running = controller.idleOperation('测试操作', () => gate.promise);
  try { for (const mutation of mutations()) await assert.rejects(mutation(), /正在测试操作/); }
  finally { gate.resolve(); await running; }
  await controller.renameAccount(account.id, 'Available');
});

test('account deletion reserves the engine while it closes so sends cannot race removed credentials', async t => {
  const { controller } = await started(t);
  const account = await controller.addAccount({ name: 'Work' }); signIn(controller, account);
  const state = await controller.switchAccount(account.id);
  const adapter = controller.adapter;
  adapter.closeGate = deferred();
  const deleting = controller.deleteAccount(account.id);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(controller.send({ sessionId: state.sessions[0].id, text: 'race' }), /正在删除账户/);
  await assert.rejects(controller.renameAccount(account.id, 'Race'), /正在删除账户/);
  adapter.closeGate.resolve();
  assert.equal((await deleting).activeAccountId, 'local');
  assert.equal(adapter.prompts.length, 0);
});

test('profile and accounts directory junctions cannot redirect account deletion outside the owned folder', async t => {
  for (const linkedPart of ['profile', 'accounts']) await t.test(linkedPart, async t => {
    const { controller, root } = fixture(t);
    const account = await controller.addAccount({ name: 'Work' });
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside data');
    const accounts = path.join(controller.dir, 'accounts');
    if (linkedPart === 'profile') fs.mkdirSync(accounts);
    const link = linkedPart === 'profile' ? path.join(accounts, account.id) : accounts;
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(controller.deleteAccount(account.id), /链接/);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside data');
    assert.equal(controller.accounts.some(a => a.id === account.id), true);
  });
});
