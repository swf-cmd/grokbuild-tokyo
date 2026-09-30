'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { packagedBundle } = require('./package-paths.cjs');

async function archivePackagedBuild(root, target) {
  const version = require(path.join(root, 'package.json')).version;
  const platform = target.platform === 'darwin' ? 'mac' : 'win';
  const filename = `Grokbuild-Tokyo-${version}-${platform}-${target.arch}.zip`;
  const source = target.platform === 'darwin' ? packagedBundle(root) : path.join(root, 'App');
  if (!fs.lstatSync(source).isDirectory()) throw new Error(`Missing packaged directory: ${source}`);
  const output = path.join(root, 'dist', filename);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  const temporaryDir = fs.mkdtempSync(path.join(root, 'work', 'package-archive-'));
  const temporary = path.join(temporaryDir, filename);
  try {
    if (process.platform === 'darwin') {
      // Preserve .app symlinks and modes without adding local extended attributes.
      // For Windows, keep the complete fresh App/ folder and runtime licenses.
      execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', '--noextattr', source, temporary], { stdio: 'inherit' });
    } else if (process.platform === 'win32') {
      // Environment variables keep paths out of PowerShell source code.
      execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $env:GROKBUILD_ARCHIVE_SOURCE -DestinationPath $env:GROKBUILD_ARCHIVE_DESTINATION -CompressionLevel Optimal"], {
        stdio: 'inherit',
        env: { ...process.env, GROKBUILD_ARCHIVE_SOURCE: source, GROKBUILD_ARCHIVE_DESTINATION: temporary },
      });
    } else {
      execFileSync('zip', ['-q', '-r', temporary, path.basename(source)], { cwd: path.dirname(source), stdio: 'inherit' });
    }
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(temporary)) hash.update(chunk);
    fs.writeFileSync(temporary + '.sha256', `${hash.digest('hex')}  ${filename}\n`);
    fs.renameSync(temporary, output);
    fs.renameSync(temporary + '.sha256', output + '.sha256');
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
  return { archive: output, checksum: output + '.sha256' };
}

module.exports = { archivePackagedBuild };
