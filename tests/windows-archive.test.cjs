'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { archivePackagedBuild } = require('../scripts/package-archive.cjs');
const { installPackagedBuild } = require('../scripts/package-policy.cjs');
const root = path.resolve(__dirname, '..');

function extract(archive, destination) {
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:GROKBUILD_TEST_ARCHIVE -DestinationPath $env:GROKBUILD_TEST_EXTRACTION"], {
      env: { ...process.env, GROKBUILD_TEST_ARCHIVE: archive, GROKBUILD_TEST_EXTRACTION: destination },
    });
  } else if (process.platform === 'darwin') {
    execFileSync('/usr/bin/ditto', ['-x', '-k', archive, destination]);
  } else {
    execFileSync('unzip', ['-q', archive, '-d', destination]);
  }
}

test('Windows release ZIP extracts a complete clean App folder with matching checksum', async () => {
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(root, 'work/windows-archive-'));
  try {
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ version: '1.2.4' }));
    const staged = path.join(fixture, 'work/package/fresh');
    const files = {
      'Grokbuild Tokyo.exe': 'test executable',
      'LICENSE': 'Electron runtime license',
      'LICENSES.chromium.html': 'Chromium runtime notices',
      'resources/app.asar': 'app sources and project licenses',
      'locales/en-US.pak': 'locale resource',
      'nested folder/quoted \' name.txt': 'path with spaces and a quote',
    };
    for (const [file, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(staged, file)), { recursive: true });
      fs.writeFileSync(path.join(staged, file), contents);
    }
    for (const file of ['data/auth.json', 'Workspace/private.txt', 'App/stale-secret.txt']) {
      fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      fs.writeFileSync(path.join(fixture, file), 'must not ship');
    }
    installPackagedBuild(fixture, staged);
    const { archive, checksum } = await archivePackagedBuild(fixture, { platform: 'win32', arch: 'x64' });
    assert.equal(path.basename(archive), 'Grokbuild-Tokyo-1.2.4-win-x64.zip');
    assert.equal(fs.readFileSync(checksum, 'utf8'), `${crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}  ${path.basename(archive)}\n`);
    const extracted = path.join(fixture, 'extracted');
    extract(archive, extracted);
    assert.deepEqual(fs.readdirSync(extracted), ['App']);
    for (const [file, contents] of Object.entries(files)) {
      assert.equal(fs.readFileSync(path.join(extracted, 'App', file), 'utf8'), contents, file);
    }
    assert.equal(fs.existsSync(path.join(extracted, 'App/stale-secret.txt')), false);
    assert.equal(fs.existsSync(path.join(extracted, 'App/data')), false);
    assert.equal(fs.existsSync(path.join(extracted, 'App/Workspace')), false);

    // A failed rebuild must keep the last downloadable archive and checksum.
    const previousArchive = fs.readFileSync(archive);
    const previousChecksum = fs.readFileSync(checksum);
    fs.rmSync(path.join(fixture, 'App'), { recursive: true });
    await assert.rejects(archivePackagedBuild(fixture, { platform: 'win32', arch: 'x64' }), /ENOENT/);
    assert.deepEqual(fs.readFileSync(archive), previousArchive);
    assert.deepEqual(fs.readFileSync(checksum), previousChecksum);
    assert.equal(fs.readdirSync(path.join(fixture, 'work')).some(name => name.startsWith('package-archive-')), false);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('Mac release ZIP still preserves bundle symlinks and executable modes', { skip: process.platform !== 'darwin' }, async () => {
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(root, 'work/mac-archive-'));
  try {
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ version: '1.2.4' }));
    const bundle = path.join(fixture, 'App/Grokbuild Tokyo.app');
    fs.mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'Contents/MacOS/Grokbuild Tokyo'), 'test executable', { mode: 0o755 });
    fs.symlinkSync('MacOS/Grokbuild Tokyo', path.join(bundle, 'Contents/current'));
    const { archive } = await archivePackagedBuild(fixture, { platform: 'darwin', arch: 'universal' });
    assert.equal(path.basename(archive), 'Grokbuild-Tokyo-1.2.4-mac-universal.zip');
    const extracted = path.join(fixture, 'extracted');
    extract(archive, extracted);
    assert.deepEqual(fs.readdirSync(extracted), ['Grokbuild Tokyo.app']);
    const contents = path.join(extracted, 'Grokbuild Tokyo.app/Contents');
    assert.equal(fs.readlinkSync(path.join(contents, 'current')), 'MacOS/Grokbuild Tokyo');
    assert.equal(fs.statSync(path.join(contents, 'MacOS/Grokbuild Tokyo')).mode & 0o777, 0o755);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
