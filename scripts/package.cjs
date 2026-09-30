'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { packager } = require('@electron/packager');
const { validatePackageSource, installPackagedBuild } = require('./package-policy.cjs');
const { parseTarget, packageOptions } = require('./package-config.cjs');
const { packagedExecutable } = require('./package-paths.cjs');
const { archivePackagedBuild } = require('./package-archive.cjs');
const root = path.resolve(__dirname, '..');

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
  const { archive, checksum } = await archivePackagedBuild(root, target);
  console.log(archive);
  console.log(checksum);
})().catch(error => { console.error(error); process.exitCode = 1; });
