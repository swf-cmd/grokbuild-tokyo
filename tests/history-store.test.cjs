'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HistoryStore } = require('../src/history-store.cjs');

function fixture(t) {
  const base = path.resolve(__dirname, '../work/history-store-tests');
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'run-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = { settings: {}, accounts: [{ id: 'local', name: 'Local' }], activeAccountId: 'local', sessions: [
    { id: 'one', title: 'One', cwd: directory, messages: [{ id: 'message-1', role: 'user', text: 'first' }] },
    { id: 'two', title: 'Two', cwd: directory, messages: [{ id: 'message-2', role: 'assistant', text: 'second' }] },
  ] };
  return { directory, state, store: new HistoryStore(directory) };
}

test('legacy history migrates atomically and only dirty conversation content is replaced', async t => {
  const { directory, state, store } = fixture(t);
  const original = JSON.stringify({ version: 2, ...state });
  fs.writeFileSync(store.file, original);
  const loaded = store.read();
  await store.save(loaded);
  assert.equal(fs.readFileSync(path.join(directory, 'conversations.v2-backup.json'), 'utf8'), original);
  const index = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.equal(index.version, 3);
  assert.equal(index.sessions[0].messages, undefined);
  const unchanged = index.sessions[1].contentFile;
  loaded.sessions[0].messages[0].text = 'changed';
  await store.save(loaded, ['one']);
  const after = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.equal(after.sessions[1].contentFile, unchanged);
  assert.notEqual(after.sessions[0].contentFile, index.sessions[0].contentFile);
  assert.deepEqual(new HistoryStore(directory).read().sessions.map(s => s.messages[0].text), ['changed', 'second']);
  assert.equal(fs.readdirSync(path.join(directory, 'sessions')).length, 2);
});

test('a failed index commit preserves old content and retries the changed conversation', async t => {
  const { directory, state, store } = fixture(t);
  await store.save(state);
  const before = fs.readFileSync(store.file, 'utf8');
  state.sessions[0].messages[0].text = 'pending';
  // The worker can write a new generation but cannot replace this occupied temp path.
  fs.mkdirSync(store.file + '.tmp');
  await assert.rejects(store.save(state, ['one']));
  assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  assert.equal(new HistoryStore(directory).read().sessions[0].messages[0].text, 'first');
  fs.rmdirSync(store.file + '.tmp');
  await store.save(state, ['one']);
  assert.equal(new HistoryStore(directory).read().sessions[0].messages[0].text, 'pending');
});

test('queued saves retain their captured messages and compose per-session generations', async t => {
  const { directory, state, store } = fixture(t);
  await store.save(state);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const writes = [];
  const write = store.write;
  store.write = async payload => { writes.push(payload); await gate; return write(payload); };
  state.sessions[0].messages[0].text = 'one committed';
  const first = store.save(state, ['one']);
  state.sessions[0].messages[0].text = 'one still streaming';
  state.sessions[1].messages[0].text = 'two committed';
  const second = store.save(state, ['two']);
  release();
  await Promise.all([first, second]);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].updates[0].messages[0].text, 'one committed');
  assert.deepEqual(new HistoryStore(directory).read().sessions.map(s => s.messages[0].text), ['one committed', 'two committed']);
});

test('metadata changes never clone or serialize historical message content', async t => {
  const { state, store } = fixture(t);
  await store.save(state);
  const message = state.sessions[0].messages[0];
  Object.defineProperty(message, 'text', { enumerable: true, get() { throw new Error('history should remain untouched'); } });
  state.sessions[0].title = 'Renamed without visiting messages';
  await store.save(state);
  const writes = [];
  store.write = async payload => writes.push(payload);
  await store.save(state);
  assert.deepEqual(writes, []);
});

test('history indices reject content path traversal', t => {
  const { state, store } = fixture(t);
  fs.writeFileSync(store.file, JSON.stringify({ version: 3, ...state, sessions: [{ id: 'bad', contentFile: '../private.json' }] }));
  assert.throws(() => store.read(), /Invalid conversation file/);
});
