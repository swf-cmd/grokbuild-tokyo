'use strict';
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');

if (!parentPort) throw new Error('History writer requires a worker thread');
const port = parentPort;
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
      await fs.writeFile(target + '.tmp', JSON.stringify({ messages }), { mode: 0o600 });
      await fs.rename(target + '.tmp', target);
    }
    const target = path.join(directory, 'conversations.json');
    await fs.writeFile(target + '.tmp', JSON.stringify(index), { mode: 0o600 });
    await fs.rename(target + '.tmp', target);
    // Immutable content generations make the index replacement the commit point.
    // Files from interrupted writes are collected only after a successful commit.
    const retained = new Set(index.sessions.map(session => session.contentFile));
    for (const file of await fs.readdir(folder).catch(() => [])) {
      if (/^[a-f0-9-]{36}\.json(?:\.tmp)?$/.test(file) && !retained.has(file)) await fs.unlink(path.join(folder, file)).catch(() => {});
    }
    port.postMessage({ id });
  } catch (error) { port.postMessage({ id, error: { message: error.message, code: error.code } }); }
});
