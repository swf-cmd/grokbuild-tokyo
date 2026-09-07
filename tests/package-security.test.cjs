'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { packageFiles, ignorePackagePath, validatePackageSource, installPackagedBuild } = require('../scripts/package-policy.cjs');
const root = path.resolve(__dirname, '..');

test('the real packager filter excludes secrets and unknown files at every depth', async () => {
  const { userPathFilter } = await import(pathToFileURL(path.join(root, 'node_modules/@electron/packager/dist/copy-filter.js')).href);
  const filter = userPathFilter({ dir: root, out: path.join(root, 'work/package'), ignore: ignorePackagePath, prune: false });
  for (const file of packageFiles) assert.equal(await filter(path.join(root, file)), true, file);
  for (const file of ['.env', '.env.production', '.npmrc', 'auth.json', 'private-key.pem', 'debug.log', 'backup.zip', '.git/config', 'data/conversations.json', 'dist/old.zip', 'out/report.json', 'coverage/credentials.json', 'src/.env', 'src/secret.cjs', 'src/renderer/assets/private.png', 'node_modules/example/index.js']) {
    assert.equal(await filter(path.join(root, file)), false, `must not ship ${file}`);
  }
});

test('package validation rejects junctions before dereferencing allowed source paths', () => {
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(root, 'work/package-security-'));
  try {
    for (const file of packageFiles) {
      fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      fs.writeFileSync(path.join(fixture, file), 'fixture');
    }
    validatePackageSource(fixture);
    const source = path.join(fixture, 'src');
    const privateSource = path.join(fixture, 'private-source');
    fs.renameSync(source, privateSource);
    fs.symlinkSync(privateSource, source, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => validatePackageSource(fixture), /symbolic link/);
    fs.unlinkSync(source);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('installing a package excludes stale destination secrets and preserves the previous build', () => {
  const fixture = fs.mkdtempSync(path.join(root, 'work/package-install-'));
  try {
    const staged = path.join(fixture, 'work/package/new-build');
    fs.mkdirSync(staged, { recursive: true });
    fs.mkdirSync(path.join(fixture, 'App'));
    fs.writeFileSync(path.join(fixture, 'App/credentials.txt'), 'test-only sentinel');
    fs.writeFileSync(path.join(staged, 'app.exe'), 'new test build');
    const { appDir, backup } = installPackagedBuild(fixture, staged);
    assert.deepEqual(fs.readdirSync(appDir), ['app.exe']);
    assert.equal(fs.readFileSync(path.join(backup, 'credentials.txt'), 'utf8'), 'test-only sentinel');
    assert.throws(() => installPackagedBuild(fixture, path.join(fixture, 'outside')), /inside work\/package/);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
