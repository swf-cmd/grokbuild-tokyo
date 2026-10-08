'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AppController } = require('../src/app-controller.cjs');
const { BlobStore } = require('../src/blob-store.cjs');

async function exists(file) {
  try { await fs.stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function fixture(t, seed) {
  const base = path.resolve(__dirname, '../work/blob-retention-tests');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'run-'));
  const controllers = [];
  const reopen = () => {
    const app = new AppController({ root, home: path.join(root, 'home') });
    controllers.push(app);
    return app;
  };
  await seed?.(root);
  const controller = reopen();
  await controller.cleanupQueue;
  t.after(async () => {
    for (const app of controllers) {
      app.journal.cancel();
      app.resetQuota();
      clearTimeout(app.modelRefreshTimer);
      await app.saveQueue.catch(() => {});
      await app.cleanupQueue.catch(() => {});
      await app.store.queue.catch(() => {});
      await app.blobs.flush().catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, controller, reopen };
}

function session(root, id, accountId = 'local', images = []) {
  return { id, title: id, titleIsDefault: false, accountId, cwd: path.join(root, 'Workspace'), messages: [{ id: `${id}-reply`, role: 'assistant', text: '', thought: '', status: 'complete', mediaVersion: 1, tools: [], images, attachments: [] }] };
}

async function legacyFixture(t, accountId) {
  return fixture(t, async root => {
    const data = { version: 2, settings: {}, accounts: [{ id: 'local', name: 'Local' }], activeAccountId: 'local', sessions: [session(root, 'local-history', 'local', [{ src: 'data:image/png;base64,bG9jYWw=' }])] };
    if (accountId) {
      data.accounts.push({ id: accountId, name: 'Private account' });
      data.sessions.push(session(root, 'private-history', accountId, [{ src: 'data:image/png;base64,cHJpdmF0ZQ==' }]));
    }
    await fs.mkdir(path.join(root, 'data'), { recursive: true });
    await fs.writeFile(path.join(root, 'data', 'conversations.json'), JSON.stringify(data));
  });
}

function backupFile(controller) { return path.join(controller.dir, 'conversations.v2-backup.json'); }

test('deleting a conversation removes its images and files after the history commit', async t => {
  const { root, controller } = await fixture(t);
  const image = controller.blobs.store(Buffer.from('private image'));
  const document = controller.blobs.store(Buffer.from('private report'));
  const chat = session(root, 'deleted', 'local', [{ src: image }]);
  chat.messages[0].attachments.push({ src: document, name: 'report.txt', mimeType: 'text/plain' });
  controller.sessions.push(chat);
  await controller.save({ content: [chat.id] });
  assert.equal(await exists(controller.blobs.resolve(image)), true);
  assert.equal(await exists(controller.blobs.resolve(document)), true);
  await controller.deleteSession(chat.id);
  assert.equal(await exists(controller.blobs.resolve(image)), false);
  assert.equal(await exists(controller.blobs.resolve(document)), false);
});

test('deleting an account removes unique blobs and retains blobs shared with another account', async t => {
  const { root, controller } = await fixture(t);
  const account = await controller.addAccount({ name: 'Private account' });
  const shared = controller.blobs.store(Buffer.from('shared image'));
  const privateFile = controller.blobs.store(Buffer.from('private account report'));
  const local = session(root, 'local-chat', 'local', [{ src: shared }]);
  const privateChat = session(root, 'private-chat', account.id, [{ src: shared }]);
  privateChat.messages[0].tools.push({ rawOutput: { nested: [{ resource: { uri: privateFile, mimeType: 'text/plain' } }] } });
  controller.sessions.push(local, privateChat);
  await controller.save({ content: [local.id, privateChat.id] });
  await controller.deleteAccount(account.id);
  assert.equal(await exists(controller.blobs.resolve(shared)), true);
  assert.equal(await exists(controller.blobs.resolve(privateFile)), false);
  await controller.deleteSession(local.id);
  assert.equal(await exists(controller.blobs.resolve(shared)), false);
});

test('a failed deletion commit retains the saved conversation and all its blobs', async t => {
  const { root, controller, reopen } = await fixture(t);
  const reference = controller.blobs.store(Buffer.from('must survive failed deletion'));
  const chat = session(root, 'retained', 'local', [{ src: reference }]);
  controller.sessions.push(chat);
  await controller.save({ content: [chat.id] });
  const write = controller.store.write;
  controller.store.write = async () => { throw new Error('fixture history commit failure'); };
  try { await assert.rejects(controller.deleteSession(chat.id), /fixture history commit failure/); }
  finally { controller.store.write = write; }
  assert.equal(await exists(controller.blobs.resolve(reference)), true);
  assert.equal(controller.sessions.some(item => item.id === chat.id), true);
  assert.equal(reopen().readSession(chat.id).messages[0].images[0].src, reference);
});

test('a failed journal reset retains journal-only blobs until a later successful reset', async t => {
  const { root, controller } = await fixture(t);
  const chat = session(root, 'journal-owner');
  controller.sessions.push(chat);
  await controller.save({ content: [chat.id] });
  const reference = controller.blobs.store(Buffer.from('only the journal retains this payload'));
  const logged = { ...chat.messages[0], images: [{ src: reference }] };
  controller.journal.begin(chat.id, logged);
  await controller.journal.flush();
  const reset = controller.journal.reset;
  controller.journal.reset = async () => { throw new Error('fixture journal reset failure'); };
  try { await controller.save({ content: [chat.id] }); }
  finally { controller.journal.reset = reset; }
  assert.equal(await exists(controller.blobs.resolve(reference)), true, 'on-disk journal references remain usable after cleanup failure');
  await controller.save({ content: [chat.id] });
  assert.equal(await exists(controller.blobs.resolve(reference)), false);
});

test('deleting a conversation discards its stale journal and collects the referenced blob', async t => {
  const { root, controller } = await fixture(t);
  const reference = controller.blobs.store(Buffer.from('stale final reply'));
  const chat = session(root, 'journal-deleted', 'local', [{ src: reference }]);
  controller.sessions.push(chat);
  await controller.save({ content: [chat.id] });
  controller.journal.begin(chat.id, chat.messages[0]);
  await controller.journal.flush();
  await controller.deleteSession(chat.id);
  assert.equal(await exists(controller.blobs.resolve(reference)), false);
  assert.equal(await exists(controller.journal.file), false);
});

test('legacy backup survives migration boot and expires after a validated v3 restart', async t => {
  const { controller, reopen } = await legacyFixture(t);
  await controller.save();
  assert.equal(await exists(backupFile(controller)), true);
  await controller.saveSettings({ musicVolume: 40 });
  assert.equal(await exists(backupFile(controller)), true, 'ordinary writes in the migration boot retain recovery data');
  const restored = reopen();
  await restored.cleanupQueue;
  assert.equal(restored.loadError, null);
  assert.equal(restored.readSession('local-history').messages.length, 1);
  assert.equal(await exists(backupFile(restored)), false);
});

test('a failed v3 restart retains its migration backup', async t => {
  const { controller, reopen } = await legacyFixture(t);
  await controller.save();
  const index = JSON.parse(await fs.readFile(controller.file, 'utf8'));
  await fs.writeFile(path.join(controller.dir, 'sessions', index.sessions[0].contentFile), '{broken');
  const restored = reopen();
  await restored.cleanupQueue;
  assert.ok(restored.loadError);
  assert.equal(await exists(backupFile(restored)), true);
});

test('deleting a conversation during the migration boot retires the private legacy backup', async t => {
  const { controller } = await legacyFixture(t);
  await controller.save();
  assert.equal(await exists(backupFile(controller)), true);
  await controller.deleteSession('local-history');
  assert.equal(await exists(backupFile(controller)), false);
});

test('deleting an account as the first legacy write cannot leave its old history in the backup', async t => {
  const accountId = randomUUID();
  const { controller } = await legacyFixture(t, accountId);
  await controller.deleteAccount(accountId);
  assert.equal(await exists(backupFile(controller)), false);
  assert.deepEqual(controller.sessions.map(chat => chat.id), ['local-history']);
});

test('a failed destructive save keeps the legacy migration backup available', async t => {
  const { controller } = await legacyFixture(t);
  await controller.save();
  const original = await fs.readFile(backupFile(controller));
  const write = controller.store.write;
  controller.store.write = async () => { throw new Error('fixture failed destructive save'); };
  try { await assert.rejects(controller.deleteSession('local-history'), /fixture failed destructive save/); }
  finally { controller.store.write = write; }
  assert.deepEqual(await fs.readFile(backupFile(controller)), original);
  assert.equal(controller.sessions.length, 1);
});

// BlobStore regressions are below the controller checks so storage races can be
// exercised deterministically without scheduling a live Grok process.
test('collected content can be stored again after its known-cache entry is removed', async t => {
  const { root } = await fixture(t);
  const store = new BlobStore(path.join(root, 'standalone-blobs'));
  const bytes = Buffer.from('recreated content');
  const reference = store.store(bytes);
  await store.flush();
  await store.collect(() => new Set());
  assert.equal(await exists(store.resolve(reference)), false);
  assert.equal(store.store(bytes), reference);
  await store.flush();
  assert.deepEqual(await fs.readFile(store.resolve(reference)), bytes);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('a blob re-added while its unlink is pending is rewritten before flush completes', { timeout: 5000 }, async t => {
  const { root } = await fixture(t);
  const store = new BlobStore(path.join(root, 'standalone-blobs'));
  const bytes = Buffer.from('referenced again during asynchronous deletion');
  const reference = store.store(bytes);
  await store.flush();
  const entered = deferred();
  const release = deferred();
  const unlink = fs.unlink;
  const mocked = t.mock.method(fs, 'unlink', async function (file, ...args) {
    if (file === store.resolve(reference)) { entered.resolve(); await release.promise; }
    return unlink.call(this, file, ...args);
  });
  const references = new Set();
  const collecting = store.collect(() => references);
  try {
    await entered.promise;
    assert.equal(store.store(bytes), reference);
    references.add(reference);
  } finally { release.resolve(); }
  await collecting;
  await store.flush();
  mocked.mock.restore();
  assert.deepEqual(await fs.readFile(store.resolve(reference)), bytes);
});

test('new media arriving during a history commit survives cleanup alongside the committed snapshot', async t => {
  const { root, controller } = await fixture(t);
  const previous = controller.blobs.store(Buffer.from('committed image'));
  const chat = session(root, 'streaming', 'local', [{ src: previous }]);
  controller.sessions.push(chat);
  await controller.save({ content: [chat.id] });
  const entered = deferred();
  const release = deferred();
  const write = controller.store.write;
  controller.store.write = async payload => { entered.resolve(); await release.promise; return write(payload); };
  const saving = controller.save({ content: [chat.id] });
  await entered.promise;
  const next = controller.blobs.store(Buffer.from('new image received during save'));
  chat.messages[0].images = [{ src: next }];
  controller.dirtySessions.add(chat.id);
  release.resolve();
  await saving;
  controller.store.write = write;
  await controller.blobs.flush();
  assert.equal(await exists(controller.blobs.resolve(previous)), true, 'the authoritative history still references the earlier snapshot');
  assert.equal(await exists(controller.blobs.resolve(next)), true, 'uncommitted streamed media is still live');
  await controller.save();
  assert.equal(await exists(controller.blobs.resolve(previous)), false);
  assert.equal(await exists(controller.blobs.resolve(next)), true);
});

test('metadata saves retain blob references in unchanged persisted message generations', async t => {
  const { root, controller } = await fixture(t);
  const reference = controller.blobs.store(Buffer.from('still referenced by persisted generation'));
  const chat = session(root, 'committed-generation', 'local', [{ src: reference }]);
  controller.sessions.push(chat);
  await controller.save({ content: [chat.id] });
  chat.messages[0].images = [];
  await controller.saveSettings({ musicVolume: 41 });
  assert.equal(await exists(controller.blobs.resolve(reference)), true, 'a metadata commit does not replace the stored messages');
  await controller.save({ content: [chat.id] });
  assert.equal(await exists(controller.blobs.resolve(reference)), false);
});

test('collection retains references returned by its provider and only removes owned hash filenames', async t => {
  const { root } = await fixture(t);
  const store = new BlobStore(path.join(root, 'standalone-blobs'));
  const retained = store.store(Buffer.from('retained'));
  const discarded = store.store(Buffer.from('discarded'));
  await store.flush();
  const unrelated = path.join(store.directory, 'notes.txt');
  await fs.writeFile(unrelated, 'unowned file');
  await store.collect(() => new Set([retained]));
  assert.equal(await exists(store.resolve(retained)), true);
  assert.equal(await exists(store.resolve(discarded)), false);
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'unowned file');
});

test('migration backup is retained when v3 content loads but account validation fails', async t => {
  const { controller, reopen } = await legacyFixture(t);
  await controller.save();
  const index = JSON.parse(await fs.readFile(controller.file, 'utf8'));
  index.accounts = [];
  await fs.writeFile(controller.file, JSON.stringify(index));
  const restored = reopen();
  await restored.cleanupQueue;
  assert.ok(restored.loadError);
  assert.equal(await exists(backupFile(restored)), true, 'reading message files alone does not prove a normal startup succeeded');
});

test('unreadable history recovery snapshots retain their blobs across replacement history and restarts', async t => {
  const { root, controller, reopen } = await fixture(t);
  const reference = controller.blobs.store(Buffer.from('media recoverable only from a corruption snapshot'));
  const recoverable = session(root, 'recoverable', 'local', [{ src: reference }]);
  const damaged = session(root, 'damaged');
  controller.sessions.push(recoverable, damaged);
  await controller.save({ content: [recoverable.id, damaged.id] });
  const index = JSON.parse(await fs.readFile(controller.file, 'utf8'));
  await fs.writeFile(path.join(controller.dir, 'sessions', index.sessions.find(item => item.id === damaged.id).contentFile), '{corrupted');
  const restored = reopen();
  await restored.cleanupQueue;
  assert.ok(restored.loadError);
  await restored.saveSettings({ rainEnabled: false });
  assert.equal(await exists(restored.blobs.resolve(reference)), true);
  const replacement = reopen();
  await replacement.cleanupQueue;
  await replacement.saveSettings({ musicVolume: 35 });
  assert.equal(await exists(replacement.blobs.resolve(reference)), true, 'a valid empty replacement index must not invalidate explicit recovery snapshots');
});

test('failed journal cleanup after deletion reports retained private data and retries on the next save', async t => {
  const { root, controller } = await fixture(t);
  const reference = controller.blobs.store(Buffer.from('private journal media pending cleanup'));
  const chat = session(root, 'cleanup-failure', 'local', [{ src: reference }]);
  controller.sessions.push(chat);
  await controller.save({ content: [chat.id] });
  controller.journal.begin(chat.id, chat.messages[0]);
  await controller.journal.flush();
  const events = [];
  controller.on('event', event => events.push(event));
  const reset = controller.journal.reset;
  controller.journal.reset = async () => { throw new Error('fixture journal cleanup denied'); };
  try { assert.equal(await controller.deleteSession(chat.id), true); }
  finally { controller.journal.reset = reset; }
  assert.equal(controller.sessions.length, 0, 'a cleanup failure does not roll back a committed deletion');
  assert.equal(await exists(controller.journal.file), true);
  assert.equal(await exists(controller.blobs.resolve(reference)), true);
  assert.ok(events.some(event => event.type === 'error' && /fixture journal cleanup denied/.test(event.message)), 'the UI must be told when a private journal could not be removed');
  await controller.save();
  assert.equal(await exists(controller.journal.file), false);
  assert.equal(await exists(controller.blobs.resolve(reference)), false);
});

test('collection removes owned temporary blob files abandoned by an interrupted write', async t => {
  const { root } = await fixture(t);
  const store = new BlobStore(path.join(root, 'standalone-blobs'));
  await fs.mkdir(store.directory, { recursive: true });
  const temporary = path.join(store.directory, `.${'a'.repeat(64)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, 'private image bytes from an interrupted write');
  await store.collect(() => new Set());
  assert.equal(await exists(temporary), false);
});

test('temporary-file cleanup leaves an in-flight blob write intact', { timeout: 5000 }, async t => {
  const { root } = await fixture(t);
  const store = new BlobStore(path.join(root, 'standalone-blobs'));
  const entered = deferred();
  const release = deferred();
  const rename = fs.rename;
  let temporary;
  const mocked = t.mock.method(fs, 'rename', async function (from, to, ...args) {
    if (path.dirname(to) === store.directory) { temporary = from; entered.resolve(); await release.promise; }
    return rename.call(this, from, to, ...args);
  });
  const bytes = Buffer.from('private media currently being written');
  const reference = store.store(bytes);
  await entered.promise;
  try {
    await store.collect(() => new Set());
    assert.equal(await exists(temporary), true, 'the writer still needs its temporary file to complete the rename');
  } finally { release.resolve(); }
  await store.flush();
  mocked.mock.restore();
  assert.deepEqual(await fs.readFile(store.resolve(reference)), bytes);
});

test('deleting the final conversation removes a journal snapshot abandoned before rename', async t => {
  const { root, controller } = await fixture(t);
  const reference = controller.blobs.store(Buffer.from('private media in an interrupted journal snapshot'));
  const chat = session(root, 'journal-temporary', 'local', [{ src: reference }]);
  controller.sessions.push(chat);
  await controller.save({ content: [chat.id] });
  const temporary = controller.journal.file + '.tmp';
  await fs.writeFile(temporary, JSON.stringify({ sessionId: chat.id, messageId: chat.messages[0].id, base: chat.messages[0] }) + '\n');
  assert.equal(await exists(controller.journal.file), false, 'a crashed snapshot can exist even when there is no current journal');
  await controller.deleteSession(chat.id);
  assert.equal(await exists(temporary), false, 'deletion must not leave the private temporary snapshot behind');
  assert.equal(await exists(controller.blobs.resolve(reference)), false);
});
