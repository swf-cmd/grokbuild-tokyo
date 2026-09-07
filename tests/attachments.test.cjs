'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { stageAttachments, attachmentsFromContent, attachmentsFromText, resolveAttachment, safeName } = require('../src/attachments.cjs');

async function fixture(t) {
  const base = path.resolve(__dirname, '../work/attachment-tests');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'run-'));
  t.after(async () => { assert.ok(root.startsWith(base + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

test('selected image and document bytes are copied, names sanitized and MIME sniffed', async t => {
  const root = await fixture(t);
  const png = await fs.readFile(path.resolve(__dirname, '../src/renderer/assets/icon.png'));
  const result = await stageAttachments([{ name: '../photo.png', mimeType: 'text/plain', data: png.toString('base64') }, { name: '报告.txt', data: Buffer.from('東京 rain').toString('base64') }], root);
  assert.equal(result[0].name, 'photo.png');
  assert.equal(result[0].mimeType, 'image/png');
  assert.ok(result[0].previewSrc.startsWith('data:image/png;base64,'));
  assert.deepEqual(await resolveAttachment(result[0].src, [root]), png);
  assert.equal((await resolveAttachment(result[1].src, [root])).toString(), '東京 rain');
  assert.equal(safeName('CON.txt'), '_CON.txt');
  const original = path.join(root, 'source.txt'); await fs.writeFile(original, 'original');
  const [copy] = await stageAttachments([original], root, { fromPaths: true });
  await fs.writeFile(original, 'edited');
  assert.equal((await fs.readFile(copy.src)).toString(), 'original');
});

test('invalid, oversized and excessive imports fail and leave no partial staged files', async t => {
  const root = await fixture(t);
  await assert.rejects(stageAttachments(Array(11).fill({ name: 'x', data: '' }), root), /10/);
  await assert.rejects(stageAttachments([{ name: 'first.txt', data: 'YWJj' }, { name: 'bad.txt', data: '<invalid>' }], root), /invalid/);
  assert.deepEqual(await fs.readdir(root), []);
  const file = path.join(root, 'large.dat'); const handle = await fs.open(file, 'w'); await handle.truncate(20 * 1024 * 1024 + 1); await handle.close();
  await assert.rejects(stageAttachments([file], root, { fromPaths: true }), /20 MB/);
});

test('the documented 20 MB boundary imports and downloads without a parser overflow', async t => {
  const root = await fixture(t);
  const bytes = Buffer.alloc(20 * 1024 * 1024, 65);
  const [file] = await stageAttachments([{ name: 'large.txt', data: bytes.toString('base64') }], root);
  assert.equal(file.size, bytes.length);
  assert.deepEqual(await resolveAttachment(file.src, [root]), bytes);
});

test('ACP text, blob and resource links produce durable downloadable attachments', async t => {
  const root = await fixture(t);
  const contents = [{ type: 'resource', resource: { uri: 'file:///report.txt', mimeType: 'text/plain', text: 'hello\n東京' } }, { type: 'content', content: { type: 'resource', resource: { uri: 'report.zip', mimeType: 'application/zip', blob: 'AAECAw==' } } }, { type: 'resource_link', uri: 'https://example.test/report.pdf', name: 'report.pdf', mimeType: 'application/pdf' }];
  const attachments = attachmentsFromContent(contents);
  assert.equal(attachments.length, 3);
  assert.equal((await resolveAttachment(attachments[0].src, [root])).toString(), 'hello\n東京');
  assert.deepEqual(await resolveAttachment(attachments[1].src, [root]), Buffer.from([0, 1, 2, 3]));
  assert.deepEqual(attachmentsFromContent(contents), attachments);
  assert.deepEqual(attachmentsFromContent({ type: 'resource', resource: { mimeType: 'image/png', blob: 'AAAA' } }), []);
  assert.deepEqual(attachmentsFromContent({ type: 'resource', resource: { mimeType: 'text/plain', blob: '*invalid*' } }), []);
});

test('Markdown file links become attachments while web pages and images remain ordinary content', () => {
  const found = attachmentsFromText('[report](<C:\\work\\报告 file.pdf>) [source](file.js) [download](https://example.test/r.csv?x=1) [web](https://example.test) ![photo](photo.png) [bad](javascript:evil)');
  assert.equal(found.length, 3);
  assert.equal(found[0].src, 'C:\\work\\报告 file.pdf');
  assert.equal(attachmentsFromText('[pending](report.pd').length, 0);
  const [parenthesized] = attachmentsFromText('[下载报告](report(1).pdf)');
  assert.equal(parenthesized.src, 'report(1).pdf');
  assert.equal(parenthesized.fileName, 'report(1).pdf');
  assert.equal(attachmentsFromText('[结论](#summary)').length, 0);
  assert.equal(attachmentsFromText('`[example](fake.txt)`').length, 0);
  assert.equal(attachmentsFromText('[报告][result]\n\n[result]: report.csv')[0].src, 'report.csv');
});

test('local downloads validate real paths, encoded paths, schemes and symlink escapes', async t => {
  const root = await fixture(t); const cwd = path.join(root, 'cwd'); const outside = path.join(root, 'outside');
  await fs.mkdir(cwd); await fs.mkdir(outside);
  const file = path.join(cwd, 'report 东京.txt'); await fs.writeFile(file, 'report');
  for (const src of [file, pathToFileURL(file).href, encodeURIComponent('report 东京.txt')]) assert.equal((await resolveAttachment(src, [cwd])).toString(), 'report');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  await fs.symlink(outside, path.join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const src of ['../outside/secret.txt', 'linked/secret.txt', 'file://server/share/a.txt', '\\\\server\\share\\a.txt', 'javascript:alert(1)', 'https://user:secret@example.test/a.txt']) await assert.rejects(resolveAttachment(src, [cwd]));
});

test('remote downloads validate redirects, status and actual streamed size', async () => {
  const replies = [new Response(null, { status: 302, headers: { location: '/file.pdf' } }), new Response('pdf bytes')];
  const urls = [];
  assert.equal((await resolveAttachment('https://example.test/start', [], undefined, async url => { urls.push(url); return replies.shift(); })).toString(), 'pdf bytes');
  assert.deepEqual(urls, ['https://example.test/start', 'https://example.test/file.pdf']);
  await assert.rejects(resolveAttachment('https://example.test/file', [], undefined, async () => new Response(null, { status: 302, headers: { location: 'file:///private' } })), /address/);
  await assert.rejects(resolveAttachment('https://example.test/file', [], undefined, async () => new Response('missing', { status: 404 })), /download failed/);
  await assert.rejects(resolveAttachment('https://example.test/file', [], undefined, async () => new Response('too big', { headers: { 'content-length': String(21 * 1024 * 1024) } })), /20 MB/);
  await assert.rejects(resolveAttachment('https://example.test/file', [], undefined, async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20 * 1024 * 1024 + 1)); controller.close(); } }))), /20 MB/);
});
