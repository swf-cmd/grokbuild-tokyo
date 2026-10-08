'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { AppController } = require('../src/app-controller.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const base = path.resolve(__dirname, '../work/controller-transaction-regressions');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'run-'));
  const controllers = [];
  const reopen = () => {
    const controller = new AppController({ root, home: path.join(root, 'home') });
    controllers.push(controller);
    return controller;
  };
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
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, controller, reopen };
}

function addSession(controller, id, text = '') {
  const session = { id, title: `Original ${id}`, titleIsDefault: false, accountId: 'local', cwd: path.join(controller.root, 'Workspace'), messages: [{ id: `${id}-message`, role: 'assistant', text, thought: '', tools: [], attachments: [], images: [], mediaVersion: 1, status: 'complete' }] };
  controller.sessions.push(session);
  return session;
}

function failFirstWrite(controller) {
  const entered = deferred();
  const release = deferred();
  const write = controller.store.write;
  let calls = 0;
  controller.store.write = async payload => {
    if (++calls === 1) {
      entered.resolve();
      await release.promise;
      throw new Error('injected first write failure');
    }
    return write(payload);
  };
  return { entered: entered.promise, release: release.resolve };
}

async function index(controller) { return JSON.parse(await fs.readFile(controller.file, 'utf8')); }

test('a failed settings transaction cannot undo or leak into a concurrent successful patch', async t => {
  const { controller } = await fixture(t);
  await controller.save();
  const gate = failFirstWrite(controller);
  const first = controller.saveSettings({ musicVolume: 11 });
  const rejected = assert.rejects(first, /injected first write failure/);
  await gate.entered;
  const second = controller.saveSettings({ rainEnabled: false });
  gate.release();
  await rejected;
  const result = await second;
  for (const settings of [result, controller.settings, (await index(controller)).settings]) {
    assert.equal(settings.musicVolume, 90, 'the rejected volume change rolls back');
    assert.equal(settings.rainEnabled, false, 'the independent successful patch survives');
  }
});

test('a failed rename cannot roll back a later rename that successfully commits', async t => {
  const { controller } = await fixture(t);
  const session = addSession(controller, 'one');
  await controller.save({ content: [session.id] });
  const gate = failFirstWrite(controller);
  const first = controller.renameSession({ sessionId: session.id, title: 'Rejected name' });
  const rejected = assert.rejects(first, /injected first write failure/);
  await gate.entered;
  const second = controller.renameSession({ sessionId: session.id, title: 'Committed name' });
  gate.release();
  await rejected;
  await second;
  assert.equal(controller.getSession(session.id).title, 'Committed name');
  assert.equal((await index(controller)).sessions[0].title, 'Committed name');
});

test('a failed delete cannot resurrect a different session deleted by the next transaction', async t => {
  const { controller } = await fixture(t);
  addSession(controller, 'one');
  addSession(controller, 'two');
  await controller.save({ content: ['one', 'two'] });
  const gate = failFirstWrite(controller);
  const first = controller.deleteSession('one');
  const rejected = assert.rejects(first, /injected first write failure/);
  await gate.entered;
  const second = controller.deleteSession('two');
  gate.release();
  await rejected;
  await second;
  assert.deepEqual(controller.sessions.map(session => session.id), ['one']);
  assert.deepEqual((await index(controller)).sessions.map(session => session.id), ['one']);
});

test('cancellation during the initial async history save never dispatches the prompt', async t => {
  const { controller } = await fixture(t);
  const session = addSession(controller, 'one');
  await controller.save({ content: ['one'] });
  controller._ensureLoaded = async () => session;
  let prompts = 0;
  controller.adapter = { async prompt() { prompts++; return { stopReason: 'end_turn' }; } };
  const entered = deferred();
  const release = deferred();
  const write = controller.store.write;
  let delayed = false;
  controller.store.write = async payload => {
    if (!delayed) { delayed = true; entered.resolve(); await release.promise; }
    return write(payload);
  };
  const sending = controller.send({ sessionId: 'one', text: 'Do not dispatch after cancellation' });
  await entered.promise;
  assert.equal((await controller.cancel('one')).cancelled, true);
  release.resolve();
  const result = await sending;
  await controller.turnPromise;
  assert.equal(prompts, 0);
  assert.equal(result.cancelled, true);
  assert.equal(result.accepted, true, 'the already committed user message consumes its draft');
  assert.equal(controller.turns.has('one'), false);
  assert.equal(session.messages.some(message => message.status === 'working'), false);
});

test('late output from a canceled unsettled turn remains recoverable after a settings save', async t => {
  const { controller, reopen } = await fixture(t);
  const session = addSession(controller, 'one');
  const message = session.messages[0];
  message.status = 'working';
  const turn = { sessionId: session.id, message, cancelled: false, settled: false };
  controller.turns.set(session.id, turn);
  controller.adapter = { async cancel() { return { cancelled: true }; } };
  await controller.save({ content: [session.id] });
  controller.journal.begin(session.id, message);
  controller.handleEvent({ type: 'text', sessionId: session.id, text: 'Before stop. ' });
  await controller.cancel(session.id);
  await controller.saveSettings({ musicVolume: 20 });
  controller.handleEvent({ type: 'text', sessionId: session.id, text: 'Late text before the CLI exits.' });
  await controller.journal.flush();
  const restored = reopen();
  const recovered = restored.readSession(session.id).messages[0];
  assert.equal(recovered.text, 'Before stop. Late text before the CLI exits.');
  assert.equal(recovered.status, 'cancelled');
});

async function allFiles(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await allFiles(file));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}

test('saving after a corrupt v3 content file preserves the complete history backup', async t => {
  const { root, controller, reopen } = await fixture(t);
  addSession(controller, 'one', 'Recoverable original one');
  addSession(controller, 'two', 'Recoverable original two');
  await controller.save({ content: ['one', 'two'] });
  const original = await index(controller);
  const originals = new Map();
  for (const session of original.sessions) {
    const file = path.join(root, 'data', 'sessions', session.contentFile);
    if (session.id === 'one') await fs.writeFile(file, '{corrupted content');
    originals.set(session.contentFile, await fs.readFile(file));
  }
  const restored = reopen();
  assert.ok(restored.loadError, 'corruption is reported instead of silently discarding history');
  await restored.saveSettings({ rainEnabled: false });
  const files = await allFiles(path.join(root, 'data'));
  assert.ok(files.some(file => path.basename(file).startsWith('conversations.json.unreadable-')), 'the original index is retained');
  for (const [name, bytes] of originals) {
    const candidates = files.filter(file => path.basename(file) === name);
    assert.ok(candidates.length, `${name} survives the next successful save`);
    assert.ok((await Promise.all(candidates.map(file => fs.readFile(file)))).some(saved => saved.equals(bytes)), `${name} preserves original bytes`);
  }
});

test('a failed account addition cannot leak into a concurrently attempted session rename', async t => {
  const { controller } = await fixture(t);
  const session = addSession(controller, 'one');
  await controller.save({ content: [session.id] });
  const gate = failFirstWrite(controller);
  const adding = controller.addAccount({ name: 'Rejected account' });
  const rejected = assert.rejects(adding, /injected first write failure/);
  await gate.entered;
  try {
    await assert.rejects(controller.renameSession({ sessionId: session.id, title: 'Premature rename' }), /Please wait|in progress|busy/i);
    assert.equal(session.title, 'Original one', 'an incompatible operation must reject before mutating session state');
  } finally { gate.release(); }
  await rejected;
  await controller.renameSession({ sessionId: session.id, title: 'Retried rename' });
  assert.deepEqual(controller.accounts.map(account => account.id), ['local']);
  const saved = await index(controller);
  assert.deepEqual(saved.accounts.map(account => account.id), ['local']);
  assert.equal(saved.sessions[0].title, 'Retried rename');
});
