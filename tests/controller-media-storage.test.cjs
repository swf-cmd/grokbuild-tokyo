'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { AppController } = require('../src/app-controller.cjs');
const { stageAttachments } = require('../src/attachments.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jlyUAAAAASUVORK5CYII=', 'base64');

async function directory(t) {
  const base = path.resolve(__dirname, '../work/controller-media-storage-tests');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'run-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function controllerAt(t, root, options = {}) {
  const controller = new AppController({ root, home: path.join(root, 'home'), ...options });
  t.after(async () => { controller.journal.cancel(); await controller.blobs.flush(); await controller.cleanupQueue; await controller.saveQueue; });
  return controller;
}

function addSession(controller, id, attachments = [], images = []) {
  const session = { id, title: id, cwd: path.join(controller.root, 'Workspace'), accountId: 'local', messages: [{ id: `${id}-reply`, role: 'assistant', text: '', status: 'complete', mediaVersion: 1, tools: [], attachments, images }] };
  controller.sessions.push(session);
  return session;
}

test('image protocol tokens expose only referenced blobs and expire across account switches', async t => {
  const root = await directory(t);
  const controller = controllerAt(t, root);
  await controller.cleanupQueue;
  const own = controller.blobs.store(png);
  const other = controller.blobs.store(Buffer.concat([png, Buffer.from('other')]));
  await controller.blobs.flush();
  addSession(controller, 'one', [], [{ src: own }]);
  addSession(controller, 'two', [], [{ src: other }]);
  const { src } = await controller.imageURL({ sessionId: 'one', src: own });
  assert.match(src, /^tokyo-image:\/\/media\//);
  const response = await controller.serveImage(src);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  await assert.rejects(controller.imageURL({ sessionId: 'one', src: other }));
  controller.activeAccountId = 'other';
  assert.equal((await controller.serveImage(src)).status, 404);
});

test('staged images belonging to another session or unsent draft are not image sources', async t => {
  const root = await directory(t);
  const controller = controllerAt(t, root);
  await controller.cleanupQueue;
  const [uploaded] = await controller.importAttachments({ files: [{ name: 'image.png', data: png.toString('base64') }] });
  addSession(controller, 'one');
  addSession(controller, 'two', [uploaded]);
  await assert.rejects(controller.imageURL({ sessionId: 'one', src: uploaded.src }));
  const allowed = await controller.imageURL({ sessionId: 'two', src: uploaded.src });
  const response = await controller.serveImage(allowed.src);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});

test('startup removes abandoned draft directories but preserves history references', async t => {
  const root = await directory(t);
  const attachments = path.join(root, 'data', 'attachments', 'local');
  const [saved, orphan] = await stageAttachments([{ name: 'saved.txt', data: 'c2F2ZWQ=' }, { name: 'orphan.txt', data: 'b3JwaGFu' }], attachments);
  const session = { id: 'saved', title: 'Saved', cwd: path.join(root, 'Workspace'), messages: [{ id: 'message', role: 'user', text: '', attachments: [saved] }] };
  await fs.writeFile(path.join(root, 'data', 'conversations.json'), JSON.stringify({ version: 2, settings: {}, sessions: [session] }));
  const controller = controllerAt(t, root);
  await controller.cleanupQueue;
  assert.equal((await fs.readFile(saved.src)).toString(), 'saved');
  await assert.rejects(fs.stat(orphan.src), { code: 'ENOENT' });
});

test('controller creates thumbnails and releases only unreferenced pending attachments', async t => {
  const root = await directory(t);
  let resized = 0;
  const nativeImage = { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 4000, height: 2000 }), resize: () => { resized++; return { toPNG: () => png }; } }) };
  const controller = controllerAt(t, root, { nativeImage });
  const [saved, draft] = await controller.importAttachments({ files: [{ name: 'saved.png', data: png.toString('base64') }, { name: 'draft.png', data: png.toString('base64') }] });
  assert.equal(resized, 2);
  assert.equal(draft.previewSrc, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(controller.pendingAttachments.get(saved.id).previewSrc, undefined);
  addSession(controller, 'saved', [saved]);
  await controller.releaseAttachments({ ids: [saved.id, draft.id], accountId: 'local' });
  assert.equal(controller.pendingAttachments.size, 0);
  assert.deepEqual(await fs.readFile(saved.src), png);
  await assert.rejects(fs.stat(draft.src), { code: 'ENOENT' });
  await controller.deleteSession('saved');
  await assert.rejects(fs.stat(saved.src), { code: 'ENOENT' });
});

test('cleanup waits for attachment staging to finish registering the pending draft', async t => {
  const root = await directory(t);
  const controller = controllerAt(t, root);
  await controller.cleanupQueue;
  let release;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const writeFile = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (...args) => {
    if (String(args[0]).endsWith('draft.txt')) { started(); await gate; }
    return writeFile(...args);
  });
  const importing = controller.importAttachments({ files: [{ name: 'draft.txt', data: 'ZHJhZnQ=' }] });
  await entered;
  const cleaning = controller.cleanAttachments();
  release();
  const [draft] = await importing;
  await cleaning;
  assert.equal((await fs.readFile(draft.src)).toString(), 'draft');
  assert.ok(controller.pendingAttachments.has(draft.id));
});

test('a rejected attachment import does not leave an unhandled cleanup queue rejection', async t => {
  const root = await directory(t);
  const controller = controllerAt(t, root);
  await assert.rejects(controller.importAttachments({ files: [{ name: 'bad.png', data: 'not base64' }] }));
  // Let Node report an unhandled rejection before another cleanup attaches a
  // handler: the caller already handled the original staging failure above.
  await new Promise(resolve => setImmediate(resolve));
  await controller.cleanupQueue;
  const [valid] = await controller.importAttachments({ files: [{ name: 'image.png', data: png.toString('base64') }] });
  assert.equal(controller.pendingAttachments.has(valid.id), true);
});
