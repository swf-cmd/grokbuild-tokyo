const path = require('node:path');
const fs = require('node:fs');
const { packager } = require('@electron/packager');
const root = path.resolve(__dirname, '..');
(async () => {
  const builds = await packager({
    dir: root, name: 'Grokbuild Tokyo', executableName: 'Grokbuild Tokyo',
    platform: 'win32', arch: 'x64', electronVersion: '44.2.0',
    out: path.join(root, 'work', 'package'), overwrite: true, asar: true,
    icon: path.join(root, 'src', 'renderer', 'assets', 'icon.ico'),
    ignore: [/^\/App($|\/)/, /^\/data($|\/)/, /^\/Workspace($|\/)/, /^\/work($|\/)/, /^\/tests($|\/)/, /^\/scripts($|\/)/, /\.lnk$/],
    win32metadata: { CompanyName: 'Local desktop project', FileDescription: 'Grokbuild Tokyo — 东京雨夜', ProductName: 'Grokbuild Tokyo' }
  });
  const appDir = path.join(root, 'App');
  fs.mkdirSync(appDir, { recursive: true });
  fs.cpSync(builds[0], appDir, { recursive: true });
  console.log(path.join(appDir, 'Grokbuild Tokyo.exe'));
})().catch(e => { console.error(e); process.exitCode = 1; });
