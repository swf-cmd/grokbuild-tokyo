'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { packageFiles } = require('./package-policy.cjs');
const { minimumMacOS, parseTarget } = require('./package-config.cjs');
const { packagedArchive, packagedBundle, packagedExecutable } = require('./package-paths.cjs');
const root = path.resolve(__dirname, '..');
(async () => {
  const target = parseTarget(process.argv.slice(2));
  const asar = await import('@electron/asar');
  const archive = packagedArchive(root, target.platform);
  const contents = asar.listPackage(archive).map(file => file.replace(/\\/g, '/').replace(/^\//, ''));
  const unexpected = contents.filter(file => !packageFiles.includes(file) && !packageFiles.some(allowed => allowed.startsWith(file + '/')));
  assert.deepEqual(unexpected, [], 'Unexpected files in app.asar');
  assert.deepEqual(packageFiles.filter(file => !contents.includes(file)), [], 'Missing runtime files');
  console.log(`PASS package inventory: ${packageFiles.length} allowed files, no unexpected files`);
  assert.equal(fs.existsSync(packagedExecutable(root, target.platform)), true, 'Missing packaged executable');
  if (target.platform === 'darwin') {
    assert.equal(process.platform, 'darwin', 'Verify Mac binary architecture and signature on macOS');
    const bundle = packagedBundle(root);
    const plist = path.join(bundle, 'Contents', 'Info.plist');
    const readPlist = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
    assert.equal(readPlist('LSMinimumSystemVersion'), minimumMacOS, 'Incorrect minimum macOS version');
    assert.equal(readPlist('CFBundleIdentifier'), 'com.swf-cmd.grokbuild-tokyo');
    assert.equal(readPlist('CFBundleShortVersionString'), require('../package.json').version);
    assert.equal(fs.existsSync(path.join(bundle, 'Contents', 'Resources', readPlist('CFBundleIconFile'))), true, 'Missing Mac icon');
    for (const [source, destination] of [['LICENSE', 'LICENSE.electron.txt'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']]) {
      assert.deepEqual(fs.readFileSync(path.join(bundle, 'Contents', 'Resources', destination)), fs.readFileSync(path.join(root, 'App', source)), `Missing or altered runtime notice: ${destination}`);
    }
    const expected = target.arch === 'universal' ? ['arm64', 'x86_64'] : [target.arch === 'x64' ? 'x86_64' : target.arch];
    for (const binary of [packagedExecutable(root, 'darwin'), path.join(bundle, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework')]) {
      const architectures = execFileSync('/usr/bin/lipo', ['-archs', binary], { encoding: 'utf8' }).trim().split(/\s+/).sort();
      for (const architecture of expected) assert.ok(architectures.includes(architecture), `Missing ${architecture} in ${binary}`);
      if (process.argv.includes('--arch')) assert.deepEqual(architectures, expected, 'Unexpected packaged architectures');
    }
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
    console.log(`PASS Mac bundle: macOS ${minimumMacOS}+, ${expected.join(' + ')}, valid code signature`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
