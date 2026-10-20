'use strict';
// Upgrading from Grokbuild Tokyo: what the controller does with saved paths
// after the Mac data folder has moved to its new name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AppController } = require('../src/app-controller.cjs');
const { adoptLegacyRoot, rootAliases } = require('../src/app-paths.cjs');

async function settle(app) {
  app.journal.cancel();
  app.resetQuota();
  clearTimeout(app.modelRefreshTimer);
  await app.saveQueue.catch(() => {});
  await app.cleanupQueue?.catch(() => {});
  await app.store.queue.catch(() => {});
  await app.blobs.flush().catch(() => {});
}

async function upgraded(t, workspace, sessionCwd) {
  const base = path.resolve(__dirname, '../work/app-rename-tests');
  fs.mkdirSync(base, { recursive: true });
  const run = fs.mkdtempSync(path.join(base, 'run-'));
  t.after(() => fs.rmSync(run, { recursive: true, force: true }));
  const legacy = path.join(run, 'Grokbuild Tokyo');
  const root = path.join(run, 'Dirth');
  const before = new AppController({ root: legacy, home: path.join(run, 'home') });
  before.settings.workspace = workspace(legacy, run);
  fs.mkdirSync(before.settings.workspace, { recursive: true });
  before.sessions.push({ id: 'saved', title: 'saved', titleIsDefault: false, accountId: 'local', cwd: sessionCwd(legacy), messages: [] });
  await before.save({ content: ['saved'] });
  await settle(before);
  fs.renameSync(legacy, root);
  const after = new AppController({ root, movedFrom: legacy, home: path.join(run, 'home') });
  t.after(() => settle(after));
  return { legacy, root, run, after };
}

test('The default workspace follows the data folder to its new name', async t => {
  const { root, after } = await upgraded(t, legacy => path.join(legacy, 'Workspace'), legacy => path.join(legacy, 'Workspace'));
  assert.equal(after.settings.workspace, path.join(root, 'Workspace'));
});

test('A workspace chosen inside the old folder keeps its place in the new one', async t => {
  const { root, after } = await upgraded(t, legacy => path.join(legacy, 'Workspace', 'client project'), legacy => path.join(legacy, 'Workspace'));
  assert.equal(after.settings.workspace, path.join(root, 'Workspace', 'client project'));
});

test('A workspace outside the data folder and saved conversation folders are not rewritten', async t => {
  const { legacy, run, after } = await upgraded(t, (_, base) => path.join(base, 'projects', 'site'), legacy => path.join(legacy, 'Workspace', 'old chat'));
  assert.equal(after.settings.workspace, path.join(run, 'projects', 'site'));
  // The CLI knows saved conversations by their folder; the link at the old path keeps it valid.
  assert.equal(after.sessions.find(session => session.id === 'saved').cwd, path.join(legacy, 'Workspace', 'old chat'));
});

test('Without a move, a workspace named like the old folder is left alone', async t => {
  const base = path.resolve(__dirname, '../work/app-rename-tests');
  fs.mkdirSync(base, { recursive: true });
  const run = fs.mkdtempSync(path.join(base, 'run-'));
  t.after(() => fs.rmSync(run, { recursive: true, force: true }));
  const elsewhere = path.join(run, 'Grokbuild Tokyo', 'Workspace');
  const root = path.join(run, 'Dirth');
  const first = new AppController({ root, home: path.join(run, 'home') });
  first.settings.workspace = elsewhere;
  await first.save();
  await settle(first);
  const again = new AppController({ root, home: path.join(run, 'home') });
  t.after(() => settle(again));
  assert.equal(again.settings.workspace, elsewhere);
});

test('Files attached before the move are kept, and still open, after the first Dirth launch', async t => {
  if (process.platform === 'win32') return t.skip('Creating directory links needs extra rights on Windows');
  const base = path.resolve(__dirname, '../work/app-rename-tests');
  fs.mkdirSync(base, { recursive: true });
  const run = fs.mkdtempSync(path.join(base, 'run-'));
  t.after(() => fs.rmSync(run, { recursive: true, force: true }));
  const legacy = path.join(run, 'Grokbuild Tokyo');
  const before = new AppController({ root: legacy, home: path.join(run, 'home') });
  const [attachment] = await before.importAttachments({ files: [{ name: 'notes.txt', data: Buffer.from('kept').toString('base64') }] });
  before.pendingAttachments.delete(attachment.id);
  before.sessions.push({ id: 'saved', title: 'saved', titleIsDefault: false, accountId: 'local', cwd: path.join(legacy, 'Workspace'),
    messages: [{ id: 'sent', role: 'user', text: 'see attached', attachments: [attachment] }] });
  await before.save({ content: ['saved'] });
  await settle(before);
  const { root, movedFrom } = adoptLegacyRoot(path.join(run, 'Dirth'), { platform: 'darwin', appData: run });
  assert.equal(movedFrom, legacy);
  const aliases = rootAliases(root, { platform: 'darwin', appData: run });
  assert.deepEqual(aliases, [legacy]);
  const after = new AppController({ root, movedFrom, aliases, home: path.join(run, 'home') });
  t.after(() => settle(after));
  await after.cleanupQueue;
  await after.cleanAttachments();
  await after.saveQueue;
  // The file now goes by the folder's own name, on disk as well as in memory.
  const moved = path.join(root, path.relative(legacy, attachment.src));
  const message = after.sessions.find(session => session.id === 'saved').messages[0];
  assert.equal(message.attachments[0].src, moved);
  assert.equal(message.attachments[0].id, attachment.id);
  assert.equal(after.sessions.find(session => session.id === 'saved').cwd, path.join(legacy, 'Workspace'), 'the CLI knows the conversation by its old folder');
  assert.equal(fs.readFileSync(moved, 'utf8'), 'kept');
  assert.equal(Buffer.from((await after.attachmentBytes({ sessionId: 'saved', messageId: 'sent', attachmentId: attachment.id }))).toString(), 'kept');
  // Grokbuild Tokyo 1.2.5, if it is opened again, keeps only uploads whose saved
  // path lies inside the real path of its attachment folder.
  const reread = new AppController({ root, home: path.join(run, 'home') });
  t.after(() => settle(reread));
  const savedSrc = reread.sessions.find(session => session.id === 'saved').messages[0].attachments[0].src;
  const oldBuildRoot = fs.realpathSync(path.join(legacy, 'data', 'attachments', 'local'));
  assert.ok(!path.relative(oldBuildRoot, savedSrc).startsWith('..'), `${savedSrc} is inside ${oldBuildRoot}`);
  // Removing the link no longer loses the file.
  fs.rmSync(legacy);
  assert.equal(Buffer.from((await reread.attachmentBytes({ sessionId: 'saved', messageId: 'sent', attachmentId: attachment.id }))).toString(), 'kept');
});
