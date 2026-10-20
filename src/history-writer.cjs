'use strict';
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');

if (!parentPort) throw new Error('History writer requires a worker thread');
const port = parentPort;

// Renaming a file into place commits it, so its bytes must reach the disk
// first: after a power loss a renamed file can otherwise come back empty, and
// an index naming an empty conversation file reads as damaged history.
async function writeDurably(file, text) {
  const handle = await fs.open(file, 'w', 0o600);
  try { await handle.writeFile(text); await handle.sync(); }
  finally { await handle.close(); }
}

// Makes the renames themselves durable. Windows cannot open a folder for this
// and NTFS journals renames, so there is nothing to do there.
async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  let handle;
  try { handle = await fs.open(directory, 'r'); await handle.sync(); }
  catch { /* Best effort: some file systems refuse to sync a folder. */ }
  finally { await handle?.close(); }
}
port.on('message', async ({ id, directory, index, updates, legacy }) => {
  try {
    const folder = path.join(directory, 'sessions');
    await fs.mkdir(folder, { recursive: true });
    // Keep the original v2 history intact until the new index commits.
    if (legacy) {
      try { await fs.copyFile(path.join(directory, 'conversations.json'), path.join(directory, 'conversations.v2-backup.json'), require('node:fs').constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error; }
    }
    for (const { file, messages } of updates) {
      const target = path.join(folder, file);
      await writeDurably(target + '.tmp', JSON.stringify({ messages }));
      await fs.rename(target + '.tmp', target);
    }
    if (updates.length) await syncDirectory(folder);
    const target = path.join(directory, 'conversations.json');
    await writeDurably(target + '.tmp', JSON.stringify(index));
    await fs.rename(target + '.tmp', target);
    await syncDirectory(directory);
    // Immutable content generations make the index replacement the commit point.
    // Files from interrupted writes are collected only after a successful commit.
    const retained = new Set(index.sessions.map(session => session.contentFile));
    for (const file of await fs.readdir(folder).catch(() => [])) {
      if (/^[a-f0-9-]{36}\.json(?:\.tmp)?$/.test(file) && !retained.has(file)) await fs.unlink(path.join(folder, file)).catch(() => {});
    }
    port.postMessage({ id });
  } catch (error) { port.postMessage({ id, error: { message: error.message, code: error.code } }); }
});
