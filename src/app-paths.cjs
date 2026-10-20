'use strict';
const nodeFs = require('node:fs');
const path = require('node:path');

const MAC_FOLDER = 'Dirth';
// Earlier names of the Mac data folder, newest first. Versions up to 1.2.5
// shipped as Grokbuild Tokyo. Builds of the rename branch were briefly called
// Akari and moved the data there, leaving Grokbuild Tokyo as a link to it.
const LEGACY_MAC_FOLDERS = ['Akari', 'Grokbuild Tokyo'];

function appRoot({ platform = process.platform, testRoot, appData, isPackaged, executablePath, sourceRoot }) {
  if (testRoot) {
    if (!path.isAbsolute(testRoot)) throw new Error('TOKYO_TEST_ROOT must be an absolute path');
    return testRoot;
  }
  // A .app may be read-only or translocated. Data must survive moving/updating it.
  if (platform === 'darwin') return path.join(appData, MAC_FOLDER);
  return isPackaged ? path.resolve(path.dirname(executablePath), '..') : sourceRoot;
}

// Chromium's profile lock on Mac is a link whose target ends in the owner's pid.
function lockedByLiveProcess(userData, fs) {
  let owner;
  try { owner = /-(\d+)$/.exec(fs.readlinkSync(path.join(userData, 'SingletonLock'))); } catch { return false; }
  if (!owner) return false;
  try { process.kill(Number(owner[1]), 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/* Carries Mac data over from the app's previous name, before anything opens it.
 *
 * The old folder is renamed into place and a symbolic link is left at its old
 * path, so absolute paths saved before the rename (each conversation's
 * folder, a workspace chosen in Preferences) keep resolving, and an older
 * build opened afterwards still finds its data. An old folder that is itself
 * a link (data kept on another disk) moves as a link, so the new name leads
 * to the same place; a link to nothing is ignored. Returns the root to use and
 * the folder it moved from, if any. Whenever the folder cannot move together
 * with its link, the old folder stays in use, so nobody opens the app to an
 * empty history or to conversations whose folders no longer resolve. While
 * the older build is still running it keeps its folder, and this launch hands
 * over to its window.
 * @param {string} root
 * @param {{ platform?: NodeJS.Platform, appData: string, testRoot?: string, fs?: typeof nodeFs, isLocked?: (userData: string) => boolean }} options
 */
function adoptLegacyRoot(root, { platform = process.platform, appData, testRoot, fs = nodeFs, isLocked = userData => lockedByLiveProcess(userData, fs) }) {
  if (testRoot || platform !== 'darwin' || path.dirname(root) !== path.resolve(appData)) return { root, movedFrom: null };
  if (fs.existsSync(root)) return { root, movedFrom: null };
  for (const name of LEGACY_MAC_FOLDERS) {
    const legacy = path.join(appData, name);
    // Follows a link: a missing folder or a link to nothing is skipped.
    try { if (!fs.statSync(legacy).isDirectory()) continue; } catch { continue; }
    if (isLocked(path.join(legacy, 'data', 'browser'))) return { root: legacy, movedFrom: null };
    try { fs.renameSync(legacy, root); } catch {
      // Another first launch may have moved it a moment ago.
      return { root: fs.existsSync(root) ? root : legacy, movedFrom: null };
    }
    try { fs.symlinkSync(root, legacy, 'dir'); } catch {
      try { fs.renameSync(root, legacy); return { root: legacy, movedFrom: null }; } catch { /* Keep the moved data. */ }
    }
    return { root, movedFrom: legacy };
  }
  return { root, movedFrom: null };
}

/* The earlier Mac folder names that lead to this same folder, through the link
 * the move left behind (or a chain of them, after Akari). Paths saved under one
 * of them name a file in this folder, so the controller can rewrite them to
 * the folder's own name: they then survive the link being removed, and an
 * older build opened afterwards, which only recognizes files by this folder's
 * real path, does not mistake them for leftovers and delete them.
 * @param {string} root
 * @param {{ platform?: NodeJS.Platform, appData: string, testRoot?: string, fs?: typeof nodeFs }} options
 * @returns {string[]}
 */
function rootAliases(root, { platform = process.platform, appData, testRoot, fs = nodeFs }) {
  if (testRoot || platform !== 'darwin' || path.dirname(root) !== path.resolve(appData)) return [];
  let real;
  try { real = fs.realpathSync(root); } catch { return []; }
  return LEGACY_MAC_FOLDERS.map(name => path.join(appData, name)).filter(legacy => {
    if (legacy === root) return false;
    try { return fs.realpathSync(legacy) === real; } catch { return false; }
  });
}

module.exports = { appRoot, adoptLegacyRoot, rootAliases, MAC_FOLDER, LEGACY_MAC_FOLDERS };
