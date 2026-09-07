'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { AccountManager } = require('../src/account-manager.cjs');
const { imagesFromContent, resolveImage } = require('../src/media.cjs');
const { GrokAdapter } = require('../src/grok-adapter.cjs');
const png = fs.readFileSync(path.resolve(__dirname, '../src/renderer/assets/icon.png'));
const encoded = png.toString('base64');
const imageBlock = { type: 'image', mimeType: 'image/png', data: encoded };

function fixture(t) {
  const base = path.resolve(__dirname, '../work/media-account-tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'run-'));
  t.after(() => { assert.ok(root.startsWith(base + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('ACP image, embedded resource and tool content retain image payloads', () => {
  const images = imagesFromContent([imageBlock, { type: 'content', content: { type: 'resource', resource: { mimeType: 'image/png', blob: encoded } } }, { type: 'resource_link', mimeType: 'image/png', uri: 'https://images.example.test/a.png' }]);
  assert.equal(images.length, 3);
  assert.equal(images[0].src, `data:image/png;base64,${encoded}`);
  assert.equal(imagesFromContent({ type: 'resource', resource: { mimeType: 'text/plain', blob: encoded } }).length, 0);
});

test('adapter streams image-only responses, marks replay and forwards tool images', () => {
  const adapter = new GrokAdapter(); const events = []; adapter.on('event', event => events.push(event));
  adapter._sessionUpdate({ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: imageBlock } });
  adapter.loading.add('s');
  adapter._sessionUpdate({ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: imageBlock } });
  adapter.loading.clear();
  adapter._sessionUpdate({ sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 't', content: [{ type: 'content', content: imageBlock }] } });
  assert.deepEqual(events.filter(e => e.type === 'image').map(e => e.replay), [false, true, false]);
  assert.equal(events.find(e => e.type === 'image').image.src, `data:image/png;base64,${encoded}`);
});

test('relative, absolute, encoded and file URL images load inside the conversation workspace', async t => {
  const root = fixture(t); const file = path.join(root, '东京 image.png'); fs.writeFileSync(file, png);
  for (const src of ['东京 image.png', encodeURIComponent('东京 image.png'), file, pathToFileURL(file).href]) {
    assert.equal((await resolveImage(src, root)).src, `data:image/png;base64,${encoded}`);
  }
});

test('image URLs and inline images are validated without arbitrary file or scheme access', async t => {
  const root = fixture(t); fs.mkdirSync(path.join(root, 'workspace')); fs.writeFileSync(path.join(root, 'private.png'), png);
  assert.equal((await resolveImage('https://images.example.test/a.png', root)).src, 'https://images.example.test/a.png');
  assert.equal((await resolveImage(`data:image/png;base64,${encoded}`, root)).src, `data:image/png;base64,${encoded}`);
  for (const src of ['../private.png', 'javascript:alert(1)', '\\\\server\\share\\x.png', 'file://server/share/x.png', 'https://user:password@example.test/a.png', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/png;base64,aGVsbG8=', 'file.txt']) {
    await assert.rejects(resolveImage(src, path.join(root, 'workspace')));
  }
  fs.writeFileSync(path.join(root, 'fake.png'), '<script>alert(1)</script>');
  await assert.rejects(resolveImage('fake.png', root), /图片格式/);
});

test('symlink escape, missing images and oversize files report recoverable errors', async t => {
  const root = fixture(t); const cwd = path.join(root, 'cwd'); const outside = path.join(root, 'outside');
  fs.mkdirSync(cwd); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'a.png'), png);
  fs.symlinkSync(outside, path.join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveImage('linked/a.png', cwd), /工作目录/);
  await assert.rejects(resolveImage('missing.png', cwd), { code: 'ENOENT' });
  fs.writeFileSync(path.join(cwd, 'huge.png'), Buffer.alloc(20 * 1024 * 1024 + 1));
  await assert.rejects(resolveImage('huge.png', cwd), /20 MB/);
});

test('Grok session images resolve relative to their cache without exposing other sessions', async t => {
  const root = fixture(t); const cwd = path.join(root, 'workspace'); const cache = path.join(root, 'sessions', 'current');
  const other = path.join(root, 'sessions', 'other');
  for (const folder of [cwd, path.join(cache, 'images'), other]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(cache, 'images', '1.png'), png); fs.writeFileSync(path.join(other, 'private.png'), png);
  for (const src of ['images/1.png', path.join(cache, 'images', '1.png')]) assert.equal((await resolveImage(src, cwd, cache)).src, `data:image/png;base64,${encoded}`);
  await assert.rejects(resolveImage(path.join(other, 'private.png'), cwd, cache), /工作目录或图片缓存/);
  await assert.rejects(resolveImage('../other/private.png', cwd, cache), /工作目录或图片缓存/);
});

function accountFixture(t, customSpawn) {
  const root = fixture(t); let child, options;
  const account = { id: randomUUID(), name: '工作账户' };
  const manager = new AccountManager({ dir: root, home: root, spawnProcess: customSpawn || ((_executable, args, supplied) => {
    assert.deepEqual(args, ['login', '--device-auth']); options = supplied;
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { setImmediate(() => child.emit('close', 1)); return true; }; return child;
  }) });
  manager.defaultHome = path.join(root, '.grok');
  t.after(() => manager.cancelLogin());
  const events = []; manager.on('login', event => events.push(event));
  const login = () => manager.startLogin(account, 'grok.exe', root);
  const authenticate = () => fs.writeFileSync(path.join(manager.homeFor(account.id), 'auth.json'), JSON.stringify({ scope: { key: 'secret-value-never-exposed', refresh_token: 'secret-refresh-never-exposed', auth_mode: 'oidc', email: 'work@example.test' } }));
  return { manager, account, events, login, authenticate, child: () => child, options: () => options };
}

test('account profiles use separate Grok homes and expose only safe display metadata', t => {
  const f = accountFixture(t); f.login(); f.authenticate();
  const summary = f.manager.summary(f.account);
  assert.equal(summary.email, 'work@example.test'); assert.equal(summary.signedIn, true);
  assert.ok(!JSON.stringify(summary).includes('secret'));
  assert.notEqual(f.options().env.GROK_HOME, f.manager.homeFor('local'));
  assert.equal(f.options().windowsHide, true); assert.equal(f.options().shell, false);
  for (const key of ['XAI_API_KEY', 'GROK_AUTH_PROVIDER_COMMAND', 'GROK_CONFIG', 'GROK_CONFIG_PATH']) assert.equal(f.options().env[key], undefined);
  assert.throws(() => f.manager.homeFor('../outside'), /无效/);
  f.child().emit('close', 0);
});

test('device login parses split output, never publishes raw tokens, and requires saved credentials', t => {
  const f = accountFixture(t); f.login();
  for (const chunk of ['  https://auth.x.ai/dev', 'ice\n\nConfirm this code in your browser:\n\n  ABCD-', 'EFGH\n', 'access_token=secret-value-never-exposed\n']) f.child().stderr.write(chunk);
  assert.equal(f.manager.loginState().url, 'https://auth.x.ai/device');
  assert.equal(f.manager.loginState().code, 'ABCD-EFGH');
  assert.ok(!JSON.stringify(f.events).includes('secret'));
  f.child().emit('close', 0);
  assert.equal(f.events.at(-1).status, 'failed'); assert.equal(f.manager.pending, null);
  f.login(); f.authenticate(); f.child().emit('close', 0);
  assert.equal(f.events.at(-1).status, 'succeeded');
});

test('login cancellation, duplicate login and spawn errors leave a retryable account', async t => {
  const f = accountFixture(t); f.login();
  assert.throws(f.login, /正在登录/);
  await f.manager.cancelLogin(); assert.equal(f.events.at(-1).status, 'cancelled'); assert.equal(f.manager.pending, null);
  f.login(); f.child().emit('error', new Error('sensitive CLI output'));
  assert.equal(f.events.at(-1).status, 'failed'); assert.ok(!JSON.stringify(f.events).includes('sensitive'));
  const broken = accountFixture(t, () => { throw new Error('failed'); });
  assert.throws(broken.login, /无法启动/); assert.equal(broken.manager.pending, null);
});

test('login cancellation escalates a stuck child and coalesces repeated cancel requests', async t => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const signals = [];
  child.kill = signal => { signals.push(signal); if (signal === 'SIGKILL') setImmediate(() => child.emit('close', 1)); return true; };
  const f = accountFixture(t, () => child); f.manager.cancelTimeoutMs = 10; f.login();
  await Promise.all([f.manager.cancelLogin(), f.manager.cancelLogin()]);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(f.manager.pending, null);
  assert.equal(f.events.filter(e => e.status === 'cancelled').length, 1);
  assert.ok(f.events.some(e => e.status === 'cancelling'));
  child.emit('close', 1);
  assert.equal(f.events.filter(e => e.status === 'cancelled').length, 1);
});

test('an unconfirmed login cancellation returns a bounded error and keeps account operations blocked', async t => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => false;
  const f = accountFixture(t, () => child); f.manager.cancelTimeoutMs = 10; f.login();
  try {
    await assert.rejects(f.manager.cancelLogin(), /无法确认登录进程已停止/);
    assert.equal(f.manager.pending.accountId, f.account.id);
    assert.equal(f.manager.loginState().status, 'cancelling');
    assert.throws(f.login, /正在登录/);
  } finally { child.emit('close', 1); }
  assert.equal(f.manager.pending, null);
  assert.equal(f.events.at(-1).status, 'cancelled');
});

test('late login output and kill error events cannot revive codes or unlock an unconfirmed child', async t => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 123;
  child.kill = () => { child.emit('error', new Error('fixture kill failed')); return false; };
  const f = accountFixture(t, () => child); f.manager.cancelTimeoutMs = 10; f.login();
  child.stderr.write('  https://auth.x.ai/device\nConfirm this code in your browser: ABCD-EFGH\n');
  assert.equal(f.manager.loginState().code, 'ABCD-EFGH');
  const cancellation = f.manager.cancelLogin();
  child.stderr.write('  https://auth.x.ai/device\nConfirm this code in your browser: LATE-CODE\n');
  try {
    await assert.rejects(cancellation, /无法确认登录进程已停止/);
    assert.deepEqual(f.manager.loginState(), { accountId: f.account.id, status: 'cancelling', url: '', code: '' });
    assert.equal(f.events.filter(e => e.status === 'cancelled').length, 0);
  } finally { child.emit('close', 1); }
  assert.equal(f.manager.pending, null);
});

test('an already exited login child can be cancelled even if its close event is missing', async t => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = 0; child.kill = () => false;
  const f = accountFixture(t, () => child); f.login();
  await f.manager.cancelLogin();
  assert.equal(f.manager.pending, null);
  assert.equal(f.events.at(-1).status, 'cancelled');
});

test('profile deletion helpers reject default homes and malformed profile identifiers', t => {
  const f = accountFixture(t);
  for (const id of ['local', '../outside', '-'.repeat(36), 'bad', null]) assert.throws(() => f.manager.stageDelete(id), /账户/);
});

test('a profile aliased by GROK_HOME cannot delete the local account data', t => {
  const f = accountFixture(t);
  f.manager.defaultHome = f.manager.homeFor(f.account.id);
  fs.mkdirSync(f.manager.defaultHome, { recursive: true });
  fs.writeFileSync(path.join(f.manager.defaultHome, 'keep.txt'), 'local fixture');
  assert.throws(() => f.manager.stageDelete(f.account.id), /包含本机 Grok 数据/);
  assert.equal(fs.readFileSync(path.join(f.manager.defaultHome, 'keep.txt'), 'utf8'), 'local fixture');
});
