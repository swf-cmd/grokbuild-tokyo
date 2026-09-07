const path = require('node:path');
const { packager } = require('@electron/packager');
const { ignorePackagePath, validatePackageSource, installPackagedBuild } = require('./package-policy.cjs');
const root = path.resolve(__dirname, '..');
(async () => {
  validatePackageSource(root);
  const builds = await packager({
    dir: root, name: 'Grokbuild Tokyo', executableName: 'Grokbuild Tokyo',
    platform: 'win32', arch: 'x64', electronVersion: '44.2.0',
    out: path.join(root, 'work', 'package'), overwrite: true, asar: true,
    icon: path.join(root, 'src', 'renderer', 'assets', 'icon.ico'),
    ignore: ignorePackagePath,
    win32metadata: { CompanyName: 'Local desktop project', FileDescription: 'Grokbuild Tokyo — 东京雨夜', ProductName: 'Grokbuild Tokyo' }
  });
  const { appDir } = installPackagedBuild(root, builds[0]);
  console.log(path.join(appDir, 'Grokbuild Tokyo.exe'));
})().catch(e => { console.error(e); process.exitCode = 1; });
