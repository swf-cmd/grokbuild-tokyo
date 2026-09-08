'use strict';
// Convert the existing Windows/renderer icon into the native macOS icon format.
// This is only needed when icon.png changes; the generated .icns is committed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
if (process.platform !== 'darwin') throw new Error('macOS sips and iconutil are required to regenerate icon.icns');
const assets = path.resolve(__dirname, '../src/renderer/assets');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbuild-icon-'));
try {
  const iconset = path.join(temporary, 'icon.iconset');
  fs.mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const filename = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      execFileSync('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), path.join(assets, 'icon.png'), '--out', path.join(iconset, filename)], { stdio: 'ignore' });
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(assets, 'icon.icns')], { stdio: 'inherit' });
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
console.log(path.join(assets, 'icon.icns'));
