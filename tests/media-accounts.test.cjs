'use strict';

// The test process only uses the credentials its fixtures create.
for (const key of ['GROK_AUTH', 'GROK_AUTH_PATH', 'XAI_API_KEY', 'GROK_CODE_XAI_API_KEY']) delete process.env[key];
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { AccountManager } = require('../src/account-manager.cjs');
const { imagesFromContent, resolveImage, findSessionImageDirectory } = require('../src/media.cjs');
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

test('adapter streams assistant images and keeps tool images inside tool updates', () => {
  const adapter = new GrokAdapter(); const events = []; adapter.on('event', event => events.push(event));
  adapter._sessionUpdate({ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: imageBlock } });
  adapter.loading.add('s');
  adapter._sessionUpdate({ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: imageBlock } });
  adapter.loading.clear();
  adapter._sessionUpdate({ sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 't', content: [{ type: 'content', content: imageBlock }] } });
  assert.deepEqual(events.filter(e => e.type === 'image').map(e => e.replay), [false, true]);
  assert.deepEqual(imagesFromContent(events.find(e => e.type === 'tool').content), imagesFromContent(imageBlock));
  assert.equal(events.find(e => e.type === 'image').image.src, `data:image/png;base64,${encoded}`);
});

test('relative, absolute, encoded and file URL images load inside the conversation workspace', async t => {
  const root = fixture(t); const file = path.join(root, '东京 image.png'); fs.writeFileSync(file, png);
  for (const src of ['东京 image.png', encodeURIComponent('东京 image.png'), file, pathToFileURL(file).href]) {
    assert.equal((await resolveImage(src, root)).src, `data:image/png;base64,${encoded}`);
  }
});

test('literal percent sequences keep their filename while encoded Markdown paths still resolve', async t => {
  const root = fixture(t);
  const literal = path.join(root, 'change%20chart.png');
  const decoded = path.join(root, 'change chart.png');
  const otherPng = Buffer.concat([png, Buffer.from('different fixture image')]);
  fs.writeFileSync(literal, png);
  fs.writeFileSync(decoded, otherPng);
  for (const src of ['change%20chart.png', literal, pathToFileURL(literal).href]) {
    assert.equal((await resolveImage(src, root)).src, `data:image/png;base64,${encoded}`);
  }
  fs.writeFileSync(path.join(root, '变化 chart.png'), otherPng);
  assert.equal((await resolveImage(encodeURIComponent('变化 chart.png'), root)).src, `data:image/png;base64,${otherPng.toString('base64')}`);
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(root, 'private.png'), png);
  await assert.rejects(resolveImage('%2e%2e/private.png', workspace), /working directory/);
});

test('image URLs and inline images are validated without arbitrary file or scheme access', async t => {
  const root = fixture(t); fs.mkdirSync(path.join(root, 'workspace')); fs.writeFileSync(path.join(root, 'private.png'), png);
  assert.equal((await resolveImage('https://images.example.test/a.png', root, undefined, undefined, async () => new Response(png))).src, `data:image/png;base64,${encoded}`);
  assert.equal((await resolveImage(`data:image/png;base64,${encoded}`, root)).src, `data:image/png;base64,${encoded}`);
  for (const src of ['../private.png', 'javascript:alert(1)', '\\\\server\\share\\x.png', 'file://server/share/x.png', 'https://user:password@example.test/a.png', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/png;base64,aGVsbG8=', 'file.txt']) {
    await assert.rejects(resolveImage(src, path.join(root, 'workspace')));
  }
  fs.writeFileSync(path.join(root, 'fake.png'), '<script>alert(1)</script>');
  await assert.rejects(resolveImage('fake.png', root), /image format/);
});

test('symlink escape, missing images and oversize files report recoverable errors', async t => {
  const root = fixture(t); const cwd = path.join(root, 'cwd'); const outside = path.join(root, 'outside');
  fs.mkdirSync(cwd); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'a.png'), png);
  fs.symlinkSync(outside, path.join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveImage('linked/a.png', cwd), /working directory/);
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
  await assert.rejects(resolveImage(path.join(other, 'private.png'), cwd, cache), /working directory and image cache/);
  await assert.rejects(resolveImage('../other/private.png', cwd, cache), /working directory and image cache/);
});

test('Grok cache discovery follows RFC 3986 workspace encoding, including punctuation', async t => {
  const root = fixture(t); const home = path.join(root, 'grok'); const cwd = path.join(root, "Tokyo (night)!'");
  fs.mkdirSync(cwd);
  const encodedCwd = encodeURIComponent(cwd).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  const cache = path.join(home, 'sessions', encodedCwd, 'current');
  fs.mkdirSync(path.join(cache, 'images'), { recursive: true }); fs.writeFileSync(path.join(cache, 'images', '1.png'), png);
  const found = await findSessionImageDirectory(home, cwd, 'current');
  assert.equal(found, fs.realpathSync(cache));
  assert.equal((await resolveImage('images/1.png', cwd, found)).src, `data:image/png;base64,${encoded}`);
  assert.equal(await findSessionImageDirectory(home, cwd, '../current'), undefined);
  assert.equal(await findSessionImageDirectory(home, 'relative-workspace', 'current'), undefined);
});

test('long multilingual workspace caches use .cwd metadata and keep other workspaces and sessions isolated', async t => {
  const root = fixture(t); const home = path.join(root, 'grok'); const cwd = path.join(root, '东京项目'.repeat(12));
  fs.mkdirSync(cwd);
  assert.ok(encodeURIComponent(cwd).length > 255);
  const otherWorkspace = path.join(home, 'sessions', 'other-1111111111111111');
  const ownWorkspace = path.join(home, 'sessions', 'workspace-2222222222222222');
  for (const [directory, storedCwd] of [[otherWorkspace, path.join(root, 'other')], [ownWorkspace, cwd]]) {
    fs.mkdirSync(path.join(directory, 'current'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.cwd'), storedCwd);
  }
  assert.equal(await findSessionImageDirectory(home, cwd, 'current'), fs.realpathSync(path.join(ownWorkspace, 'current')));
  assert.equal(await findSessionImageDirectory(home, cwd, 'missing'), undefined);
  fs.writeFileSync(path.join(ownWorkspace, '.cwd'), path.join(root, 'unrelated'));
  assert.equal(await findSessionImageDirectory(home, cwd, 'current'), undefined);
});

test('Windows cache discovery tolerates canonical path prefixes and case differences', { skip: process.platform !== 'win32' }, async t => {
  const root = fixture(t); const home = path.join(root, 'grok'); const cwd = path.join(root, 'Case Workspace');
  fs.mkdirSync(cwd);
  const canonicalCwd = '\\\\?\\' + cwd.toUpperCase();
  const encodedCwd = encodeURIComponent(canonicalCwd).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  const cache = path.join(home, 'sessions', encodedCwd, 'current');
  fs.mkdirSync(cache, { recursive: true });
  assert.equal(await findSessionImageDirectory(home, cwd, 'current'), fs.realpathSync(cache));
});

test('cache discovery ignores junctions, malformed metadata and missing caches without blocking workspace images', async t => {
  const root = fixture(t); const home = path.join(root, 'grok'); const cwd = path.join(root, 'workspace');
  const outside = path.join(root, 'outside'); fs.mkdirSync(cwd); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(cwd, 'local.png'), png);
  const encodedCwd = encodeURIComponent(cwd).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'current'));
  fs.symlinkSync(outside, path.join(home, 'sessions', encodedCwd), process.platform === 'win32' ? 'junction' : 'dir');
  const fake = path.join(home, 'sessions', 'fake-1111111111111111');
  fs.mkdirSync(path.join(fake, 'current'), { recursive: true }); fs.writeFileSync(path.join(fake, '.cwd'), 'x'.repeat(32769));
  const linkedSession = path.join(home, 'sessions', 'linked-2222222222222222');
  fs.mkdirSync(linkedSession); fs.writeFileSync(path.join(linkedSession, '.cwd'), cwd);
  fs.symlinkSync(path.join(outside, 'current'), path.join(linkedSession, 'current'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const candidateHome of [home, path.join(root, 'missing-home')]) {
    const found = await findSessionImageDirectory(candidateHome, cwd, 'current');
    assert.equal(found, undefined);
    assert.equal((await resolveImage('local.png', cwd, found)).src, `data:image/png;base64,${encoded}`);
  }
});

function accountFixture(t, customSpawn) {
  const root = fixture(t); let child, options;
  const account = { id: randomUUID(), name: '工作账户' };
  const manager = new AccountManager({ dir: root, home: root, getLanguage: () => 'zh-CN', spawnProcess: customSpawn || ((_executable, args, supplied) => {
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

function withLocalAuthEnv(overrides, action) {
  const keys = ['GROK_AUTH', 'GROK_AUTH_PATH', 'XAI_API_KEY', 'GROK_CODE_XAI_API_KEY'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) {
      if (overrides[key] === undefined) delete process.env[key];
      else process.env[key] = overrides[key];
    }
    return action();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('local account summaries honor inline and custom-store precedence without exposing credentials', t => {
  const f = accountFixture(t); const local = { id: 'local', name: 'Local' };
  const root = f.manager.dir; const custom = path.join(root, 'custom-auth.json');
  const credential = { key: 'secret-fixture-token', auth_mode: 'oidc', email: 'custom@example.test' };
  fs.mkdirSync(f.manager.homeFor('local'), { recursive: true });
  fs.writeFileSync(path.join(f.manager.homeFor('local'), 'auth.json'), JSON.stringify({ scope: { ...credential, email: 'default@example.test' } }));
  fs.writeFileSync(custom, JSON.stringify({ scope: credential }));
  f.manager.getWorkingDirectory = () => root;
  for (const override of [custom, 'custom-auth.json']) withLocalAuthEnv({ GROK_AUTH_PATH: override }, () => {
    assert.equal(f.manager.summary(local).email, 'custom@example.test');
    assert.equal(f.manager.summary(f.account).signedIn, false);
  });
  withLocalAuthEnv({ GROK_AUTH_PATH: custom, GROK_AUTH: JSON.stringify({ ...credential, email: 'inline@example.test' }) }, () => {
    const summary = f.manager.summary(local);
    assert.equal(summary.email, 'inline@example.test');
    assert.equal(summary.signedIn, true);
    assert.ok(!JSON.stringify(summary).includes('secret-fixture-token'));
  });
  withLocalAuthEnv({ GROK_AUTH_PATH: custom, GROK_AUTH: 'invalid-json' }, () => assert.equal(f.manager.summary(local).email, 'custom@example.test'));
  for (const override of [path.join(root, 'missing.json'), '']) withLocalAuthEnv({ GROK_AUTH_PATH: override }, () => assert.equal(f.manager.summary(local).signedIn, false));
  fs.writeFileSync(custom, 'invalid-json');
  withLocalAuthEnv({ GROK_AUTH_PATH: custom }, () => assert.equal(f.manager.summary(local).signedIn, false));
});

test('local API key status follows primary and legacy precedence without authenticating isolated profiles', t => {
  const f = accountFixture(t); const local = { id: 'local', name: 'Local' };
  for (const key of ['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY']) withLocalAuthEnv({ [key]: 'secret-fixture-key' }, () => {
    const summary = f.manager.summary(local);
    assert.equal(summary.signedIn, true); assert.equal(summary.email, '');
    assert.equal(f.manager.summary(f.account).signedIn, false);
    assert.ok(!JSON.stringify(summary).includes('secret-fixture-key'));
  });
  withLocalAuthEnv({ XAI_API_KEY: '', GROK_CODE_XAI_API_KEY: 'legacy-fixture-key' }, () => assert.equal(f.manager.summary(local).signedIn, false));
});

test('successful local login reads a relative custom auth store using the actual CLI working directory', t => {
  const f = accountFixture(t); const local = { id: 'local', name: 'Local' };
  f.manager.getWorkingDirectory = () => path.join(f.manager.dir, 'different-workspace');
  withLocalAuthEnv({ GROK_AUTH_PATH: 'custom-auth.json' }, () => {
    f.manager.startLogin(local, 'grok.exe', f.manager.dir);
    fs.writeFileSync(path.join(f.manager.dir, 'custom-auth.json'), JSON.stringify({ scope: { key: 'secret-fixture-token', auth_mode: 'oidc', email: 'signed-in@example.test' } }));
    f.child().emit('close', 0);
    assert.equal(f.events.at(-1).status, 'succeeded');
    assert.ok(!JSON.stringify(f.events).includes('secret-fixture-token'));
  });
});

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

test('profile environments remove both API key names and login overrides while local accounts retain them', t => {
  const f = accountFixture(t);
  const loginOverrides = ['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY', 'GROK_AUTH', 'GROK_AUTH_PATH', 'GROK_DEPLOYMENT_KEY', 'GROK_EXTRA_AUTH_KEY', 'GROK_TRACE_UPLOAD_CREDENTIALS_FILE', 'OTEL_EXPORTER_OTLP_HEADERS', 'GROK_INTERNAL_OTLP_HEADERS', 'GROK_CONFIG', 'GROK_CONFIG_PATH', 'GROK_AUTH_PROVIDER_COMMAND', 'GROK_AUTH_TOKEN_TTL', 'GROK_OIDC_ISSUER', 'GROK_OAUTH2_CLIENT_ID', 'GROK_FORCE_LOGIN_TEAM_UUID'];
  const values = Object.fromEntries(loginOverrides.map(key => [key, process.env[key]]));
  try {
    for (const key of loginOverrides) process.env[key] = 'fixture-login-override';
    const isolated = f.manager.environment(f.account.id);
    const local = f.manager.environment('local');
    for (const key of loginOverrides) {
      assert.equal(isolated[key], undefined, `${key} must not authenticate a different profile`);
      assert.equal(local[key], 'fixture-login-override', `${key} must remain available to the local CLI account`);
    }
    const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH');
    assert.ok(pathKey && isolated[pathKey] === process.env[pathKey]);
  } finally {
    for (const key of loginOverrides) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
  }
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
