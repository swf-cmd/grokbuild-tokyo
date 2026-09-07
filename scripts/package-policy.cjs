'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Shipping a file is an explicit decision. Git ignores are not packaging rules.
const packageFiles = [
  'package.json', 'THIRD_PARTY_NOTICES.md',
  'licenses/DOMPurify-LICENSE.txt', 'licenses/marked-LICENSE.txt',
  'src/account-manager.cjs', 'src/app-controller.cjs', 'src/attachments.cjs',
  'src/grok-adapter.cjs', 'src/i18n.js', 'src/locales.js', 'src/main.cjs',
  'src/media.cjs', 'src/model-labels.cjs', 'src/preload.cjs', 'src/resource-download.cjs',
  'src/renderer/ambient-audio.js', 'src/renderer/app.js', 'src/renderer/index.html',
  'src/renderer/styles.css', 'src/renderer/vendor/marked.umd.js',
  'src/renderer/vendor/purify.min.js', 'src/renderer/assets/icon.ico',
  'src/renderer/assets/icon.png', 'src/renderer/assets/tokyo-afterimage.wav',
  'src/renderer/assets/tokyo-rain.png',
];
const allowed = new Set(['', ...packageFiles]);
for (const file of packageFiles) {
  let parent = path.posix.dirname(file);
  while (parent !== '.') { allowed.add(parent); parent = path.posix.dirname(parent); }
}
function ignorePackagePath(file) {
  return !allowed.has(file.replace(/\\/g, '/').replace(/^\//, ''));
}
function validatePackageSource(root) {
  // Packager normally dereferences symlinks. Never let an allowed path point
  // at credentials or other content outside the reviewed source tree.
  for (const file of allowed) {
    if (!file) continue;
    const stat = fs.lstatSync(path.join(root, file));
    if (stat.isSymbolicLink()) throw new Error(`Refusing to package a symbolic link: ${file}`);
    if (packageFiles.includes(file) ? !stat.isFile() : !stat.isDirectory()) throw new Error(`Invalid package source: ${file}`);
  }
}
function installPackagedBuild(root, build) {
  const ownedRoot = path.resolve(root);
  const appDir = path.join(ownedRoot, 'App');
  const stagingRoot = path.join(ownedRoot, 'work', 'package');
  const staged = path.resolve(build);
  const relative = path.relative(stagingRoot, staged);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Packaged build must be inside work/package');
  // Replacing a whole build prevents stale files (including locally added data)
  // from leaking into a release. Preserve the previous build for recovery.
  const backups = path.join(ownedRoot, 'work', 'package-backups');
  fs.mkdirSync(backups, { recursive: true });
  let backup;
  if (fs.existsSync(appDir)) {
    backup = path.join(fs.mkdtempSync(path.join(backups, 'previous-')), 'App');
    fs.renameSync(appDir, backup);
  }
  try { fs.renameSync(staged, appDir); }
  catch (error) {
    if (backup && !fs.existsSync(appDir)) fs.renameSync(backup, appDir);
    throw error;
  }
  return { appDir, backup };
}
module.exports = { packageFiles, ignorePackagePath, validatePackageSource, installPackagedBuild };
