'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AccountManager } = require('../src/account-manager.cjs');

test('device login never publishes OAuth secrets hidden in encoded query keys or fragments', async t => {
  const base = path.resolve(__dirname, '..', 'work', 'account-security-tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'run-'));
  let child;
  const manager = new AccountManager({ dir: root, home: root, spawnProcess: () => {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { setImmediate(() => child.emit('close', 1)); return true; };
    return child;
  } });
  const account = { id: randomUUID(), name: 'Fixture' };
  const events = [];
  manager.on('login', event => events.push(event));
  t.after(async () => {
    await manager.cancelLogin();
    assert.ok(path.resolve(root).startsWith(base + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const secret = 'fixture-secret-never-publish';
  const unsafe = [
    `https://auth.x.ai/device?access%5Ftoken=${secret}`,
    `https://auth.x.ai/device?%74oken=${secret}`,
    `https://auth.x.ai/device?id_token=${secret}`,
    `https://auth.x.ai/device?client_secret=${secret}`,
    `https://auth.x.ai/device?api-key=${secret}`,
    `https://auth.x.ai/device#access_token=${secret}`,
    `https://auth.x.ai/device#/callback?refresh_token=${secret}`,
    `https://name:${secret}@auth.x.ai/device`,
  ];
  for (const url of unsafe) {
    manager.startLogin(account, 'fixture.exe', root);
    child.stderr.write(`  ${url}\nConfirm this code in your browser: ABCD-EFGH\n`);
    assert.equal(manager.loginState().url, '', 'credential-bearing links must not be exposed to the renderer');
    assert.ok(!JSON.stringify(events).includes(secret));
    child.emit('close', 1);
  }
  for (const url of ['https://auth.x.ai/device', 'https://auth.x.ai/device?user_code=ABCD-EFGH']) {
    manager.startLogin(account, 'fixture.exe', root);
    child.stderr.write(`  ${url}\nConfirm this code in your browser: ABCD-EFGH\n`);
    assert.equal(manager.loginState().url, url);
    assert.equal(manager.loginState().code, 'ABCD-EFGH');
    child.emit('close', 1);
  }
});
