'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { executableName, defaultExecutable, isExecutable, cliEnvironment, findGrokExecutable } = require('../src/platform.cjs');

function fixture(t) {
  const base = path.resolve(__dirname, '..', 'work', 'platform-tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function executable(file, mode = 0o755) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode });
  return file;
}

test('Grok executable defaults follow native macOS and Windows installation paths', () => {
  assert.equal(executableName('darwin'), 'grok');
  assert.equal(executableName('win32'), 'grok.exe');
  assert.equal(defaultExecutable('/Users/example', 'darwin'), '/Users/example/.grok/bin/grok');
  assert.equal(defaultExecutable('C:\\Users\\Example', 'win32'), 'C:\\Users\\Example\\.grok\\bin\\grok.exe');
});

test('macOS GUI PATH supplies both Homebrew architectures while preserving configured tools and credentials', () => {
  const original = { PATH: '/custom/bin:/usr/bin:/custom/bin', GROK_HOME: '/profiles/work', TOKEN: 'fixture' };
  const env = cliEnvironment(original, { home: '/Users/example', platform: 'darwin', executable: '/custom/grok install/grok' });
  const bins = env.PATH.split(':');
  assert.deepEqual(bins.slice(0, 2), ['/custom/bin', '/usr/bin']);
  for (const expected of ['/Users/example/.grok/bin', '/Users/example/.local/bin', '/Users/example/.cargo/bin', '/Users/example/.bun/bin', '/Users/example/bin', '/custom/grok install', '/opt/homebrew/bin', '/usr/local/bin', '/bin']) assert.ok(bins.includes(expected), expected);
  assert.equal(bins.length, new Set(bins).size);
  assert.equal(env.GROK_HOME, original.GROK_HOME);
  assert.equal(env.TOKEN, original.TOKEN);
  assert.equal(original.PATH, '/custom/bin:/usr/bin:/custom/bin');
  assert.deepEqual(cliEnvironment(original, { platform: 'win32' }), original);
  assert.ok(cliEnvironment({}, { home: '/Users/example', platform: 'darwin' }).PATH.includes('/usr/bin'));
});

test('executable validation accepts native binaries and symlinks and rejects missing or non-executable paths', { skip: process.platform === 'win32' }, t => {
  const root = fixture(t);
  const binary = executable(path.join(root, 'Grok Tools', 'grok'));
  const link = path.join(root, 'grok-link');
  fs.symlinkSync(binary, link);
  assert.equal(isExecutable(binary), true);
  assert.equal(isExecutable(link), true);
  assert.equal(isExecutable(path.dirname(binary)), false);
  assert.equal(isExecutable(path.join(root, 'missing')), false);
  assert.equal(isExecutable('relative/grok'), false);
  assert.equal(isExecutable(null), false);
  assert.equal(isExecutable(executable(path.join(root, 'downloaded-grok'), 0o644)), false);
  assert.equal(isExecutable(binary, 'win32'), false);
  assert.equal(isExecutable(executable(path.join(root, 'grok.EXE'), 0o644), 'win32'), true);
});

test('discovery prefers the native installer path, then executable PATH entries, and preserves a useful missing default', { skip: process.platform === 'win32' }, t => {
  const home = fixture(t);
  const pathBinary = executable(path.join(home, 'tools with spaces', 'grok'));
  const options = { home, platform: 'darwin', env: { PATH: `relative:${path.dirname(pathBinary)}` } };
  assert.equal(findGrokExecutable(options), pathBinary);
  const defaultBinary = executable(defaultExecutable(home, 'darwin'));
  assert.equal(findGrokExecutable(options), defaultBinary);
  fs.chmodSync(defaultBinary, 0o644);
  assert.equal(findGrokExecutable(options), pathBinary);
  fs.unlinkSync(pathBinary);
  // Linux has no machine-wide macOS fallbacks, making this independent of any
  // Grok installed on the computer running the test.
  assert.equal(findGrokExecutable({ home, platform: 'linux', env: { PATH: 'relative' } }), defaultBinary);
});
