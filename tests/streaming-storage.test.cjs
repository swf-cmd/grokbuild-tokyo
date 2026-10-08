'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { LineFramer } = require('../src/grok-adapter.cjs');
const { BlobStore } = require('../src/blob-store.cjs');
const { TurnJournal, readTurnJournal } = require('../src/turn-journal.cjs');
const { stageAttachments, cleanupAttachments, attachmentsFromContent } = require('../src/attachments.cjs');
const { imagesFromContent, resolveImageResponse, findSessionImageDirectory } = require('../src/media.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jlyUAAAAASUVORK5CYII=', 'base64');

async function fixture(t) {
  const base = path.resolve(__dirname, '../work/streaming-storage-tests');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'run-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('large ACP lines scan each incoming chunk once and enforce limits before joining', () => {
  const framer = new LineFramer(32 * 1024 * 1024);
  const chunk = 'a'.repeat(1024);
  let scans = 0;
  let scanned = 0;
  const tracked = { length: chunk.length, indexOf(char, start) { scans++; scanned += chunk.length - start; return chunk.indexOf(char, start); }, slice: (...args) => chunk.slice(...args) };
  const lines = [];
  for (let index = 0; index < 24 * 1024; index++) framer.push(tracked, line => lines.push(line));
  assert.equal(lines.length, 0);
  assert.equal(scans, 24 * 1024);
  assert.equal(scanned, 24 * 1024 * 1024);
  framer.push('\nfirst\r\nsecond\nunfinished', line => lines.push(line));
  assert.equal(lines[0].length, 24 * 1024 * 1024);
  assert.deepEqual(lines.slice(1), ['first\r', 'second']);
  framer.push('\n', line => lines.push(line));
  assert.equal(lines.at(-1), 'unfinished');
  const limited = new LineFramer(8);
  limited.push('1234', () => {});
  assert.throws(() => limited.push('56789\n', () => assert.fail('Oversized line delivered')), { code: 'PROTOCOL_LIMIT' });
  assert.equal(limited.parts.length, 0);
});

test('tool media, attachments and duplicate data URLs share content-addressed blobs', async t => {
  const root = await fixture(t);
  const store = new BlobStore(path.join(root, 'blobs'));
  const input = { content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }, { type: 'resource', resource: { uri: 'report.txt', mimeType: 'text/plain', text: 'report contents' } }], images: [{ src: `data:image/png;base64,${png.toString('base64')}` }], rawOutput: { mimeType: 'image/png', data: png.toString('base64') } };
  const output = store.externalize(input);
  assert.ok(input.content[0].data, 'original payload stays unchanged');
  assert.equal(output.content[0].data, undefined);
  assert.equal(output.content[0].uri, output.images[0].src);
  assert.equal(output.rawOutput.uri, output.images[0].src);
  assert.equal(imagesFromContent(output.content)[0].src, output.images[0].src);
  const [attachment] = attachmentsFromContent(output.content);
  assert.equal(attachment.name, 'report.txt');
  assert.equal(attachment.fileName, 'report.txt');
  await store.flush();
  assert.deepEqual(await fs.readFile(store.resolve(output.images[0].src)), png);
  assert.equal((await fs.readFile(store.resolve(attachment.src))).toString(), 'report contents');
  assert.equal((await fs.readdir(store.directory)).length, 2);
  assert.throws(() => store.resolve('grok-blob:../../secret'));
  assert.ok(!JSON.stringify(output).includes(png.toString('base64')));
});

test('journal compacts a long tool turn to recoverable live snapshots', async t => {
  const root = await fixture(t);
  const journal = new TurnJournal(path.join(root, 'turn.journal'), { maxBytes: 4096 });
  t.after(() => journal.cancel());
  const message = { id: 'reply', role: 'assistant', text: '', tools: [] };
  journal.begin('session', message);
  for (let index = 0; index < 100; index++) {
    const event = { type: 'tool', toolCallId: 'tool', content: 'x'.repeat(500), progress: index };
    message.tools = [event];
    journal.record('session', message.id, event);
    journal.flush();
  }
  assert.ok((await fs.stat(journal.file)).size < 4096);
  const restored = readTurnJournal(journal.file).get(message.id);
  const final = restored.events.at(-1) || restored.base.tools[0];
  assert.equal(final.progress, 99);
  assert.ok(restored.events.length < 10);
});

test('journal waits for blob durability before writing references', async t => {
  const root = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const journal = new TurnJournal(path.join(root, 'turn.journal'), { beforeFlush: () => gate });
  t.after(() => journal.cancel());
  journal.begin('session', { id: 'reply', images: [{ src: 'grok-blob:' + 'a'.repeat(64) }] });
  const flushed = journal.flush();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(syncFs.existsSync(journal.file), false);
  release();
  await flushed;
  assert.equal(readTurnJournal(journal.file).size, 1);
});

test('large attachment previews use resized nativeImage bytes and orphan cleanup retains live files', async t => {
  const root = await fixture(t);
  const large = Buffer.concat([png, Buffer.alloc(128 * 1024)]);
  const calls = [];
  const nativeImage = { createFromBuffer(bytes) { assert.equal(bytes.length, large.length); return { isEmpty: () => false, getSize: () => ({ width: 4000, height: 2000 }), resize(options) { calls.push(options); return { toPNG: () => png }; } }; } };
  const [image] = await stageAttachments([{ name: 'large.png', data: large.toString('base64') }], root, { nativeImage });
  assert.deepEqual(calls, [{ width: 320 }]);
  assert.equal(image.previewSrc, `data:image/png;base64,${png.toString('base64')}`);
  const [orphan] = await stageAttachments([{ name: 'unused.txt', data: Buffer.from('unused').toString('base64') }], root);
  await fs.mkdir(path.join(root, 'unrelated'));
  const outside = path.join(root, 'unrelated', 'keep.txt');
  await fs.writeFile(outside, 'keep');
  const linked = '00000000-0000-0000-0000-000000000000';
  await fs.symlink(path.join(root, 'unrelated'), path.join(root, linked), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await cleanupAttachments(root, [image]), [orphan.id]);
  assert.equal((await fs.readFile(image.src)).length, large.length);
  assert.equal((await fs.readFile(outside)).toString(), 'keep');
  assert.ok((await fs.lstat(path.join(root, linked))).isSymbolicLink());
});

test('image protocol responses stream bounded validated files without base64 conversion', async t => {
  const root = await fixture(t);
  const cwd = path.join(root, 'cwd');
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'image.png'), png);
  await fs.writeFile(path.join(root, 'private.png'), png);
  const response = await resolveImageResponse('image.png', cwd);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('content-length'), String(png.length));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  await assert.rejects(resolveImageResponse('../private.png', cwd), /directory/);
  await fs.symlink(root, path.join(cwd, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveImageResponse('outside/private.png', cwd), /directory/);
  const store = new BlobStore(path.join(root, 'blobs'));
  const reference = store.store(png);
  await store.flush();
  const blob = await resolveImageResponse(store.resolve(reference), cwd, undefined, undefined, undefined, [store.directory]);
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), png);
});

test('session image directory lookup caches successful workspace scans and revalidates replacements', async t => {
  const root = await fixture(t);
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'workspace');
  const workspaceCache = path.join(home, 'sessions', 'hashed-workspace');
  const cache = path.join(workspaceCache, 'session');
  await fs.mkdir(cache, { recursive: true });
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(workspaceCache, '.cwd'), cwd);
  const readdir = fs.readdir;
  let scans = 0;
  t.mock.method(fs, 'readdir', async (...args) => { if (args[0] === path.join(home, 'sessions')) scans++; return readdir(...args); });
  assert.equal(await findSessionImageDirectory(home, cwd, 'session'), cache);
  assert.equal(await findSessionImageDirectory(home, cwd, 'session'), cache);
  assert.equal(scans, 1);
  await fs.rmdir(cache);
  await fs.symlink(cwd, cache, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await findSessionImageDirectory(home, cwd, 'session'), undefined);
  assert.equal(scans, 2);
});

test('blob flush retries failed disk writes without retaining a permanent error', async t => {
  const root = await fixture(t);
  const store = new BlobStore(path.join(root, 'blobs'));
  const writeFile = fs.writeFile;
  let full = true;
  t.mock.method(fs, 'writeFile', async (...args) => {
    if (full && String(args[0]).endsWith('.tmp')) throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
    return writeFile(...args);
  });
  const ref = store.store(png);
  await assert.rejects(store.flush(), /disk full/);
  assert.equal(store.pending.size, 1, 'failed bytes remain available for retry');
  full = false;
  await store.flush();
  assert.equal(store.pending.size, 0);
  assert.deepEqual(await fs.readFile(store.resolve(ref)), png);
});

test('oversized or invalid embedded resources do not survive in serialized state', async t => {
  const root = await fixture(t);
  const store = new BlobStore(path.join(root, 'blobs'));
  const huge = 'A'.repeat(Math.ceil((20 * 1024 * 1024 + 3) / 3) * 4);
  const output = store.externalize({ content: [{ type: 'image', mimeType: 'image/png', data: huge }, { type: 'resource', resource: { mimeType: 'application/zip', blob: '**invalid**' } }], src: `data:image/png;base64,${huge}` });
  assert.equal(output.content[0].data, undefined);
  assert.match(output.content[0].blobError, /20 MB/);
  assert.equal(output.content[1].resource.blob, undefined);
  assert.ok(JSON.stringify(output).length < 1024);
  await store.flush();
});

test('journal reset waits for newer blob writes and preserves turns begun during the wait', async t => {
  const root = await fixture(t);
  let release;
  let gate = Promise.resolve();
  const journal = new TurnJournal(path.join(root, 'turn.journal'), { beforeFlush: () => gate });
  t.after(() => journal.cancel());
  journal.begin('old', { id: 'old-reply', text: 'complete' });
  await journal.flush();
  gate = new Promise(resolve => { release = resolve; });
  const reset = journal.reset([]);
  journal.begin('new', { id: 'new-reply', images: [{ src: 'grok-blob:' + 'a'.repeat(64) }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readTurnJournal(journal.file).has('new-reply'), false);
  release();
  await reset;
  assert.deepEqual([...readTurnJournal(journal.file).keys()], ['new-reply']);
  assert.deepEqual([...journal.replies.keys()], ['new-reply']);
});
