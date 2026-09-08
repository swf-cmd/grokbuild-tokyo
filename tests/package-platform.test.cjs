'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseTarget, packageOptions } = require('../scripts/package-config.cjs');
const { packagedArchive, packagedExecutable } = require('../scripts/package-paths.cjs');
const root = path.resolve(__dirname, '..');

test('build defaults preserve Windows x64 and use the native Mac architecture', () => {
  assert.deepEqual(parseTarget([], { platform: 'win32', arch: 'arm64' }), { platform: 'win32', arch: 'x64' });
  assert.deepEqual(parseTarget([], { platform: 'darwin', arch: 'arm64' }), { platform: 'darwin', arch: 'arm64' });
  assert.deepEqual(parseTarget(['--platform', 'win32'], { platform: 'darwin', arch: 'arm64' }), { platform: 'win32', arch: 'x64' });
  assert.deepEqual(parseTarget(['--platform', 'darwin', '--arch', 'universal']), { platform: 'darwin', arch: 'universal' });
  assert.throws(() => parseTarget(['--arch', 'universal'], { platform: 'win32', arch: 'x64' }), /Windows builds/);
  assert.throws(() => parseTarget(['--platform', 'linux']), /Unsupported platform/);
  assert.throws(() => parseTarget(['--arch']), /Usage/);
});

test('Mac and Windows ship the same runtime and assets with platform-specific metadata', () => {
  const mac = packageOptions(root, { platform: 'darwin', arch: 'universal' });
  const win = packageOptions(root, { platform: 'win32', arch: 'x64' });
  assert.equal(mac.electronVersion, '44.2.0');
  assert.equal(win.electronVersion, mac.electronVersion);
  assert.equal(mac.ignore, win.ignore);
  assert.equal(mac.asar, true);
  assert.equal(mac.extendInfo.LSMinimumSystemVersion, '13.0');
  assert.equal(mac.appBundleId, 'com.swf-cmd.grokbuild-tokyo');
  assert.ok(mac.icon.endsWith('.icns'));
  assert.ok(win.icon.endsWith('.ico'));
  assert.deepEqual(mac.osxUniversal, { mergeASARs: true });
});

test('packaged checks resolve the actual Windows and macOS bundle layouts', () => {
  assert.equal(packagedArchive(root, 'darwin'), path.join(root, 'App', 'Grokbuild Tokyo.app', 'Contents', 'Resources', 'app.asar'));
  assert.equal(packagedExecutable(root, 'darwin'), path.join(root, 'App', 'Grokbuild Tokyo.app', 'Contents', 'MacOS', 'Grokbuild Tokyo'));
  assert.equal(packagedArchive(root, 'win32'), path.join(root, 'App', 'resources', 'app.asar'));
  assert.equal(packagedExecutable(root, 'win32'), path.join(root, 'App', 'Grokbuild Tokyo.exe'));
});
