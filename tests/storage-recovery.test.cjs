'use strict';
// Recovery and persistence edge cases: replies rebuilt after a crash, damaged
// blobs, unreadable history backups, quitting, and text that looks like media.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { AppController } = require('../src/app-controller.cjs');
const { HistoryStore } = require('../src/history-store.cjs');
const { attachmentsFromText } = require('../src/attachments.cjs');
const { executableName } = require('../src/platform.cjs');

for (const key of ['GROK_AUTH', 'GROK_AUTH_PATH', 'XAI_API_KEY', 'GROK_CODE_XAI_API_KEY']) delete process.env[key];

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jlyUAAAAASUVORK5CYII=';
const exists = file => fs.existsSync(file);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeRoot(t) {
  const base = path.resolve(__dirname, '..', 'work', 'storage-recovery-tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'home', '.grok', 'bin', executableName());
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'fake executable; never launched', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'home', '.grok', 'auth.json'), JSON.stringify({ 'https://auth.x.ai::grok-cli': { key: 'fixture', auth_mode: 'oidc' } }));
  return root;
}

function adapterClass() {
  const instances = [];
  let next = 0;
  class FakeAdapter extends EventEmitter {
    constructor() {
      super();
      instances.push(this);
      this.prompts = [];
      this.sessions = new Map();
      this.info = { capabilities: { loadSession: true }, models: [{ id: 'm', name: 'M' }], modes: [] };
    }
    getInfo() { return this.info; }
    getSession(id) { const session = this.sessions.get(id); return session && structuredClone(session); }
    async start() {}
    async newSession() {
      const session = { sessionId: `session-${++next}`, loaded: true, model: 'm', mode: '', models: this.info.models, modes: [], modelSelectionVerified: true };
      this.sessions.set(session.sessionId, session);
      return this.getSession(session.sessionId);
    }
    async loadSession({ sessionId }) {
      const session = { sessionId, loaded: true, model: 'm', mode: '', models: this.info.models, modes: [], modelSelectionVerified: true };
      this.sessions.set(sessionId, session);
      return this.getSession(sessionId);
    }
    // The CLI answers when the test resolves the prompt's gate; Stop is never acknowledged.
    async prompt(args) { const gate = deferred(); this.prompts.push({ ...args, gate }); return gate.promise; }
    async cancel() { return { cancelled: true }; }
    async close() { for (const prompt of this.prompts) prompt.gate.resolve({ stopReason: 'cancelled' }); }
  }
  return { FakeAdapter, instances };
}

function open(t, root, Adapter) {
  const controller = new AppController({ root, home: path.join(root, 'home'), ...(Adapter ? { Adapter } : {}) });
  controller.accountManager.defaultHome = path.join(root, 'home', '.grok');
  t.after(() => settle(controller));
  return controller;
}

async function settle(controller) {
  controller.journal.cancel();
  controller.resetQuota();
  clearTimeout(controller.modelRefreshTimer);
  await controller.saveQueue.catch(() => {});
  await controller.cleanupQueue?.catch(() => {});
  await controller.store.queue.catch(() => {});
  await controller.blobs.flush().catch(() => {});
}

// What a crash leaves: the journal is flushed, nothing else runs.
async function crash(controller) {
  await controller.journal.flush();
  controller.journal.cancel();
  controller.resetQuota();
  await controller.saveQueue.catch(() => {});
}

test('a reply rebuilt after a crash is saved with its conversation, even after Stop', async t => {
  const root = makeRoot(t);
  const { FakeAdapter, instances } = adapterClass();
  const first = open(t, root, FakeAdapter);
  const a = await first.createSession();
  const b = await first.createSession();
  await first.send({ sessionId: a.id, text: 'Write the migration plan' });
  instances[0].emit('event', { type: 'text', sessionId: a.id, text: 'Step 1: back up the database.' });
  instances[0].emit('event', { type: 'image', sessionId: a.id, image: { src: `data:image/png;base64,${png}` } });
  const image = a.messages[1].images[0].src;
  // Stop, which the CLI has not confirmed, then look at another conversation (which saves).
  await first.cancel(a.id);
  await first.selectSession(b.id);
  await crash(first);

  const second = open(t, root, FakeAdapter);
  await second.cleanupQueue;
  assert.equal(second.sessions.find(session => session.id === a.id).messages[1].text, 'Step 1: back up the database.');
  assert.ok(second.dirtySessions.has(a.id), 'the recovered reply is written with the next save');
  await second.saveSettings({ musicVolume: 20 });
  await second.cleanBlobs();
  assert.equal(exists(second.journal.file), false);
  assert.ok(exists(second.blobs.resolve(image)), 'its image is kept');
  await second.close();

  const third = open(t, root, FakeAdapter);
  await third.cleanupQueue;
  const reply = third.readSession(a.id).messages[1];
  assert.equal(reply.text, 'Step 1: back up the database.');
  assert.equal(reply.status, 'cancelled');
  assert.deepEqual(reply.images.map(item => item.src), [image]);
});

test('quitting keeps a finished reply that is still waiting for its save', async t => {
  const root = makeRoot(t);
  const { FakeAdapter, instances } = adapterClass();
  const controller = open(t, root, FakeAdapter);
  const a = await controller.createSession();
  const b = await controller.createSession();
  const adapter = instances[0];
  await controller.send({ sessionId: a.id, text: 'question A' });
  await controller.send({ sessionId: b.id, text: 'question B' });
  adapter.emit('event', { type: 'text', sessionId: a.id, text: 'Complete answer A.' });
  adapter.emit('event', { type: 'text', sessionId: b.id, text: 'Complete answer B.' });
  // B's final save is slow; A finishes behind it.
  const gate = deferred();
  const write = controller.store.write;
  let slowed = false;
  controller.store.write = async payload => { if (!slowed) { slowed = true; await gate.promise; } return write(payload); };
  adapter.prompts.find(prompt => prompt.sessionId === b.id).gate.resolve({ stopReason: 'end_turn' });
  while (!slowed) await new Promise(resolve => setImmediate(resolve));
  adapter.prompts.find(prompt => prompt.sessionId === a.id).gate.resolve({ stopReason: 'end_turn' });
  while (!controller.turns.get(a.id)?.settled) await new Promise(resolve => setImmediate(resolve));
  const closing = controller.close();
  await new Promise(resolve => setImmediate(resolve));
  gate.resolve();
  await closing;
  const saved = new HistoryStore(controller.dir).read().sessions;
  assert.deepEqual(saved.map(session => [session.messages[1].text, session.messages[1].status]).sort(),
    [['Complete answer A.', 'complete'], ['Complete answer B.', 'complete']]);
});

test('a damaged stored file is replaced instead of blocking every later save', async t => {
  const root = makeRoot(t);
  const { FakeAdapter } = adapterClass();
  const first = open(t, root, FakeAdapter);
  const session = await first.createSession();
  const bytes = Buffer.from('a screenshot the CLI returns again later');
  const ref = first.blobs.store(bytes);
  session.messages.push({ id: 'r', role: 'assistant', text: '', images: [{ src: ref }], attachments: [], tools: [], mediaVersion: 1, status: 'complete' });
  await first.save({ content: [session.id] });
  await first.close();
  // Cut short by a power loss: the right name, the wrong size.
  fs.writeFileSync(first.blobs.resolve(ref), '');

  const second = open(t, root, FakeAdapter);
  await second.cleanupQueue;
  assert.equal(second.blobs.store(bytes), ref);
  await second.send({ sessionId: second.sessions[0].id, text: 'still saves' });
  await second.createSession();
  assert.equal(second.blobs.pending.size, 0);
  assert.deepEqual(fs.readFileSync(second.blobs.resolve(ref)), bytes);
  await second.close();
});

test('uploads named by a backup of unreadable history are kept until it is dealt with', async t => {
  const root = makeRoot(t);
  const first = open(t, root);
  await first.cleanupQueue;
  const [upload] = await first.importAttachments({ files: [{ name: 'tax-return.pdf', data: Buffer.from('%PDF private').toString('base64') }] });
  first.pendingAttachments.delete(upload.id);
  const message = { id: 'm', role: 'user', text: 'attached', attachments: [upload], images: [], mediaVersion: 1, status: 'complete' };
  first.sessions.push({ id: 'kept', title: 'kept', titleIsDefault: false, accountId: 'local', cwd: path.join(root, 'Workspace'), messages: [message] });
  first.sessions.push({ id: 'damaged', title: 'damaged', titleIsDefault: false, accountId: 'local', cwd: path.join(root, 'Workspace'), messages: [] });
  await first.save({ content: ['kept', 'damaged'] });
  await settle(first);
  const index = JSON.parse(fs.readFileSync(first.file, 'utf8'));
  fs.writeFileSync(path.join(first.dir, 'sessions', index.sessions.find(session => session.id === 'damaged').contentFile), '{truncated');

  const second = open(t, root);
  await second.cleanupQueue;
  assert.ok(second.loadError);
  await second.cleanAttachments();
  assert.ok(exists(upload.src), 'kept while the unreadable history is reported');
  await second.close();

  // The next launch reads the replacement history without an error.
  const third = open(t, root);
  await third.cleanupQueue;
  assert.equal(third.loadError, null);
  await third.cleanAttachments();
  assert.ok(exists(upload.src), 'still kept: the backup names it');
  // A folder nothing names is still cleaned up.
  const [stray] = await third.importAttachments({ files: [{ name: 'draft.txt', data: Buffer.from('draft').toString('base64') }] });
  await third.releaseAttachments({ ids: [stray.id] });
  assert.equal(exists(stray.src), false);
});

test('text that begins with a data URL stays text, in messages and in streamed replies', async t => {
  const root = makeRoot(t);
  const { FakeAdapter, instances } = adapterClass();
  const controller = open(t, root, FakeAdapter);
  const session = await controller.createSession();
  const question = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4= why does this not render in Safari?';
  await controller.send({ sessionId: session.id, text: question });
  const chunks = ['Try this instead:\n```\n', 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0i', 'aHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=\n```'];
  for (const text of chunks) instances[0].emit('event', { type: 'text', sessionId: session.id, text });
  instances[0].emit('event', { type: 'thought', sessionId: session.id, text: 'data:text/plain;base64,aGk=' });
  assert.equal(session.messages[1].text, chunks.join(''));
  instances[0].prompts[0].gate.resolve({ stopReason: 'end_turn' });
  await controller.turnPromise;
  await controller.saveQueue;
  const saved = new HistoryStore(controller.dir).read().sessions[0].messages;
  assert.equal(saved[0].text, question);
  assert.equal(saved[1].text, chunks.join(''));
  assert.equal(saved[1].thought, 'data:text/plain;base64,aGk=');
  // Real media in a media field is still stored once, outside the history.
  assert.match(controller.blobs.externalize({ src: `data:image/png;base64,${png}` }).src, /^grok-blob:[a-f0-9]{64}$/);
  await controller.close();
});

test('the app can quit while account data awaiting recovery blocks saving', async t => {
  const root = makeRoot(t);
  const id = '11111111-2222-4333-8444-555555555555';
  // A staged deletion whose quarantine name is already taken cannot be isolated.
  fs.mkdirSync(path.join(root, 'data', 'accounts', `.deleting-${id}`), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'accounts', `.recovery-${id}`), { recursive: true });
  const controller = open(t, root);
  assert.ok(controller.accountRecoveryError);
  assert.throws(() => controller.save(), { message: controller.accountRecoveryError });
  await controller.close();
  assert.ok(fs.existsSync(path.join(root, 'data', 'accounts', `.deleting-${id}`)), 'nothing was overwritten');
  assert.equal(fs.existsSync(controller.file), false);
});

test('scanning a long reply for file links takes time in proportion to its length', () => {
  const paragraph = index => `Paragraph ${index}: the function \`parse\` returns **early**, see [notes ${index}](docs/notes-${index}.md).`;
  const reply = count => Array.from({ length: count }, (_, index) => paragraph(index)).join('\n\n');
  const timed = text => { const start = performance.now(); const found = attachmentsFromText(text); return { found: found.length, ms: performance.now() - start }; };
  timed(reply(200));
  const short = timed(reply(500));
  const long = timed(reply(4000));
  assert.equal(short.found, 500);
  assert.equal(long.found, 4000);
  // Eight times the text: a linear scan takes about eight times as long, a
  // quadratic one about sixty-four. Allow generous noise.
  assert.ok(long.ms < Math.max(short.ms, 2) * 30, `500 paragraphs ${short.ms.toFixed(1)} ms, 4000 paragraphs ${long.ms.toFixed(1)} ms`);
});

test('showing a stored image does not search the CLI session folders', async t => {
  const root = makeRoot(t);
  const { FakeAdapter } = adapterClass();
  const controller = open(t, root, FakeAdapter);
  const session = await controller.createSession();
  const src = controller.blobs.store(Buffer.from(png, 'base64'));
  session.messages.push({ id: 'r', role: 'assistant', text: '', images: [{ src }], attachments: [], tools: [], mediaVersion: 1, status: 'complete' });
  const sessions = path.join(controller.accountManager.homeFor('local'), 'sessions');
  fs.mkdirSync(path.join(sessions, 'some-workspace'), { recursive: true });
  const fsp = require('node:fs/promises');
  const readdir = fsp.readdir;
  let scans = 0;
  t.mock.method(fsp, 'readdir', async (...args) => { if (path.resolve(String(args[0])) === path.resolve(sessions)) scans++; return readdir(...args); });
  const { src: url } = await controller.imageURL({ sessionId: session.id, src });
  assert.match(url, /^tokyo-image:\/\/media\//);
  const response = await controller.serveImage(url);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(png, 'base64'));
  assert.equal(scans, 0);
  await controller.close();
});
