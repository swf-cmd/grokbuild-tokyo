'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { packager } = require('@electron/packager');
const { validatePackageSource, installPackagedBuild } = require('./package-policy.cjs');
const { parseTarget, packageOptions } = require('./package-config.cjs');
const { packagedExecutable, packagedBundle } = require('./package-paths.cjs');
const root = path.resolve(__dirname, '..');

async function archiveMacApp(target) {
  const version = require('../package.json').version;
  const filename = `Grokbuild-Tokyo-${version}-mac-${target.arch}.zip`;
  const output = path.join(root, 'dist', filename);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = path.join(fs.mkdtempSync(path.join(root, 'work', 'package-archive-')), filename);
  try {
    // ditto preserves .app symlinks and executable modes. Archive only the fresh
    // bundle, excluding local extended attributes and any development data.
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', '--noextattr', packagedBundle(root), temporary], { stdio: 'inherit' });
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(temporary)) hash.update(chunk);
    fs.renameSync(temporary, output);
    fs.writeFileSync(output + '.sha256', `${hash.digest('hex')}  ${filename}\n`);
  } finally {
    fs.rmSync(path.dirname(temporary), { recursive: true, force: true });
  }
  console.log(output);
  console.log(output + '.sha256');
}

(async () => {
  const target = parseTarget(process.argv.slice(2));
  if (target.platform === 'darwin' && process.platform !== 'darwin') {
    throw new Error('Build the Mac release on macOS with Xcode Command Line Tools (xcode-select --install). Universal merging, codesign and ditto require macOS.');
  }
  validatePackageSource(root);
  const builds = await packager(packageOptions(root, target));
  if (builds.length !== 1) throw new Error(`Expected one build, received ${builds.length}`);
  if (target.platform === 'darwin') {
    const bundle = path.join(builds[0], 'Grokbuild Tokyo.app');
    // Electron places these next to the bundle. Keep them inside the .app so
    // the ZIP and a drag-to-Applications install retain the runtime notices.
    for (const [source, destination] of [['LICENSE', 'LICENSE.electron.txt'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']]) {
      fs.copyFileSync(path.join(builds[0], source), path.join(bundle, 'Contents', 'Resources', destination));
    }
    // A local ad-hoc signature makes both Intel and Apple Silicon binaries
    // internally valid. It does not provide Developer ID trust or notarization.
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,requirements,flags,runtime', bundle], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  }
  installPackagedBuild(root, builds[0]);
  console.log(packagedExecutable(root, target.platform));
  if (target.platform === 'darwin') await archiveMacApp(target);
})().catch(error => { console.error(error); process.exitCode = 1; });
