'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { pathToFileURL } = require('node:url');
const { GrokAdapter } = require('../src/grok-adapter.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jlyUAAAAASUVORK5CYII=', 'base64');

async function fixture(t, { capabilities = {}, onPrompt } = {}) {
  const base = path.resolve(__dirname, '..', 'work', 'attachment-transport-tests');
  await fs.mkdir(base, { recursive: true });
  const cwd = await fs.mkdtemp(path.join(base, 'run-'));
  const requests = [], events = [];
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  child.kill = signal => { child.signalCode = signal; child.emit('exit', null, signal); };
  const send = message => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  child.stdin.on('data', bytes => {
    const request = JSON.parse(bytes.toString());
    requests.push(request);
    queueMicrotask(() => {
      if (request.method === 'initialize') send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: capabilities } } });
      else if (request.method === 'session/new') send({ id: request.id, result: { sessionId: 'files-session' } });
      else if (request.method === 'session/prompt') {
        if (onPrompt) onPrompt(request, send);
        else send({ id: request.id, result: { stopReason: 'end_turn' } });
      }
    });
  });
  const adapter = new GrokAdapter({ cwd, spawnProcess: () => child });
  adapter.on('event', event => events.push(event));
  t.after(async () => {
    await adapter.close();
    assert(path.resolve(cwd).startsWith(base + path.sep));
    await fs.rm(cwd, { recursive: true, force: true });
  });
  const { sessionId } = await adapter.newSession();
  const file = async (name, bytes, mimeType) => {
    const filename = path.join(cwd, name);
    await fs.writeFile(filename, bytes);
    return { path: filename, name, mimeType, size: bytes.length };
  };
  return { adapter, events, requests, sessionId, file, send, cwd };
}

test('ordinary text prompts retain the original ACP payload', async t => {
  const { adapter, requests, sessionId } = await fixture(t);
  await adapter.prompt({ sessionId, text: 'Check this project' });
  assert.deepEqual(requests.find(item => item.method === 'session/prompt').params.prompt, [{ type: 'text', text: 'Check this project' }]);
  await assert.rejects(adapter.prompt({ sessionId }), { code: 'EMPTY_PROMPT' });
  await assert.rejects(adapter.prompt({ sessionId, text: 'hi', attachments: {} }), { code: 'INVALID_ATTACHMENT' });
});

test('image:false and missing image capability send local resource references with exact paths', async t => {
  for (const capabilities of [{ image: false }, {}]) {
    const { adapter, requests, sessionId, file } = await fixture(t, { capabilities });
    const attachment = await file('截图 100% #1.png', png, 'image/png');
    await adapter.prompt({ sessionId, attachments: [attachment] });
    const content = requests.find(item => item.method === 'session/prompt').params.prompt;
    assert.deepEqual(content.map(item => item.type), ['resource_link', 'text']);
    assert.equal(content[0].uri, pathToFileURL(attachment.path).href);
    assert.equal(content[0].name, attachment.name);
    assert.equal(content[0].size, png.length);
    assert(content[0]._meta, 'avoid legacy Grok automatic @ expansion of encoded Windows URIs');
    assert(content[1].text.includes(JSON.stringify(attachment.path)));
    assert.match(content[1].text, /read_file/);
    assert.match(content[1].text, /contents are not embedded/);
  }
});

test('image:true embeds validated image bytes and combines arbitrary file references with text', async t => {
  const { adapter, requests, sessionId, file } = await fixture(t, { capabilities: { image: true, embeddedContext: true } });
  const picture = await file('picture.png', png, 'image/png');
  const document = await file('report 数据.pdf', Buffer.from('%PDF-1.7\nfixture'), 'application/pdf');
  await adapter.prompt({ sessionId, text: 'Compare these attachments', attachments: [picture, document] });
  const content = requests.find(item => item.method === 'session/prompt').params.prompt;
  assert.deepEqual(content.map(item => item.type), ['text', 'image', 'resource_link', 'text']);
  assert.equal(content[1].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(content[1].data, 'base64'), png);
  assert.equal(content[2].uri, pathToFileURL(document.path).href);
  assert.equal(content[2].mimeType, 'application/pdf');
  assert(!content.some(item => item.type === 'resource'), 'binary documents stay readable local files instead of unsupported blob context');
});

test('malformed, missing, non-image and oversized files fail without dispatching a partial prompt', async t => {
  const { adapter, requests, sessionId, file, cwd } = await fixture(t, { capabilities: { image: true } });
  const attachment = await file('document.txt', Buffer.from('hello'), 'text/plain');
  await assert.rejects(adapter.prompt({ sessionId, attachments: [{ ...attachment, path: 'relative.txt' }] }), { code: 'INVALID_ATTACHMENT' });
  await assert.rejects(adapter.prompt({ sessionId, attachments: [{ ...attachment, path: path.join(cwd, 'missing.txt') }] }), { code: 'ENOENT' });
  await assert.rejects(adapter.prompt({ sessionId, attachments: [{ ...attachment, mimeType: 'image/png' }] }), /图片/);
  const handle = await fs.open(attachment.path, 'w');
  await handle.truncate(20 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(adapter.prompt({ sessionId, attachments: [attachment] }), { code: 'ATTACHMENT_LIMIT' });
  assert.equal(requests.filter(item => item.method === 'session/prompt').length, 0);
  assert.equal(adapter.active.size, 0);
});

test('file batches above 50 MB are rejected before a request is sent', async t => {
  const { adapter, requests, sessionId, file } = await fixture(t);
  const attachment = await file('large.zip', Buffer.alloc(0), 'application/zip');
  const handle = await fs.open(attachment.path, 'w');
  await handle.truncate(18 * 1024 * 1024);
  await handle.close();
  await assert.rejects(adapter.prompt({ sessionId, attachments: [attachment, attachment, attachment] }), { code: 'ATTACHMENT_LIMIT' });
  assert.equal(requests.filter(item => item.method === 'session/prompt').length, 0);
});

test('attachment preparation reserves the turn, rejects double sends and honors cancellation', async t => {
  const { adapter, requests, sessionId, file, events } = await fixture(t);
  const attachment = await file('notes.txt', Buffer.from('notes'), 'text/plain');
  let release;
  const original = adapter._promptContent.bind(adapter);
  adapter._promptContent = async (...args) => { await new Promise(resolve => { release = resolve; }); return original(...args); };
  const pending = adapter.prompt({ sessionId, attachments: [attachment] });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(adapter.prompt({ sessionId, text: 'duplicate' }), { code: 'SESSION_BUSY' });
  await adapter.cancel(sessionId);
  release();
  assert.equal((await pending).cancelled, true);
  assert.equal(requests.filter(item => item.method === 'session/prompt').length, 0);
  assert(events.some(item => item.status === 'cancelled'));
});

test('non-image ACP resources become attachment events in messages, tools and replay', async t => {
  const { adapter, sessionId, events, send } = await fixture(t);
  const link = { type: 'resource_link', uri: 'file:///reports/result.pdf', name: 'result.pdf', mimeType: 'application/pdf', size: 42 };
  const update = data => send({ method: 'session/update', params: { sessionId, update: data } });
  adapter.loading.add(sessionId);
  update({ sessionUpdate: 'user_message_chunk', content: link });
  adapter.loading.delete(sessionId);
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'resource', resource: { uri: 'file:///reports/notes.txt', mimeType: 'text/plain', text: 'Some notes' } } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'build-report', content: [{ type: 'content', content: link }] });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: png.toString('base64') } });
  const attachments = events.filter(item => item.type === 'attachment');
  assert.equal(attachments.length, 3);
  assert.equal(attachments[0].role, 'user');
  assert.equal(attachments[0].replay, true);
  assert.equal(attachments[0].attachment.name, 'result.pdf');
  assert.equal(attachments[1].role, 'assistant');
  assert.equal(attachments[1].replay, false);
  assert.equal(attachments[2].role, 'assistant');
  assert.equal(events.filter(item => item.type === 'image').length, 1);
  assert(!events.some(item => item.type === 'text' && item.text === 'Some notes'), 'embedded documents are not duplicated into assistant chat text');
});

test('ACP responses above the former 16 MB line cap are accepted within the attachment bound', async t => {
  const { adapter, events, send, sessionId } = await fixture(t);
  send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: {
    type: 'resource', resource: { uri: 'file:///reports/large.txt', mimeType: 'text/plain', text: 'x'.repeat(17 * 1024 * 1024) },
  } } } });
  assert.equal(adapter.ready, true);
  assert.equal(events.filter(item => item.type === 'attachment').length, 1);
  assert(!events.some(item => item.status === 'disconnected'));
});
