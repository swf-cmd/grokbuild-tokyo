'use strict';
const path = require('node:path');
const { ignorePackagePath } = require('./package-policy.cjs');

// Electron 44 dropped macOS 12. Do not lower this without changing and testing
// the runtime: https://www.electronjs.org/blog/electron-44-0
const minimumMacOS = '13.0';

function parseTarget(argv = [], host = process) {
  const target = {
    platform: host.platform === 'darwin' ? 'darwin' : 'win32',
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--platform', '--arch'].includes(key) || !argv[i + 1]) {
      throw new Error('Usage: node scripts/package.cjs [--platform win32|darwin] [--arch x64|arm64|universal]');
    }
    target[key.slice(2)] = argv[i + 1];
  }
  target.arch ||= target.platform === 'darwin' && host.platform === 'darwin' ? host.arch : 'x64';
  if (!['win32', 'darwin'].includes(target.platform)) throw new Error(`Unsupported platform: ${target.platform}`);
  if (target.platform === 'win32' && target.arch !== 'x64') throw new Error('Windows builds currently support x64 only');
  if (target.platform === 'darwin' && !['x64', 'arm64', 'universal'].includes(target.arch)) throw new Error(`Unsupported Mac architecture: ${target.arch}`);
  return target;
}

function packageOptions(root, target) {
  const manifest = require(path.join(root, 'package.json'));
  const options = {
    dir: root, name: 'Grokbuild Tokyo', executableName: 'Grokbuild Tokyo',
    ...target, electronVersion: manifest.devDependencies.electron,
    appVersion: manifest.version,
    out: path.join(root, 'work', 'package'), overwrite: true, asar: true,
    ignore: ignorePackagePath,
  };
  if (target.platform === 'darwin') {
    Object.assign(options, {
      appBundleId: 'com.swf-cmd.grokbuild-tokyo',
      appCategoryType: 'public.app-category.developer-tools',
      icon: path.join(root, 'src', 'renderer', 'assets', 'icon.icns'),
      darwinDarkModeSupport: true,
      extendInfo: { LSMinimumSystemVersion: minimumMacOS, NSHighResolutionCapable: true },
      osxUniversal: { mergeASARs: true },
    });
  } else {
    Object.assign(options, {
      icon: path.join(root, 'src', 'renderer', 'assets', 'icon.ico'),
      win32metadata: { CompanyName: 'swf-cmd', FileDescription: 'Grokbuild Tokyo — 东京雨夜', ProductName: 'Grokbuild Tokyo' },
    });
  }
  return options;
}

module.exports = { minimumMacOS, parseTarget, packageOptions };
