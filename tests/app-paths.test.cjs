'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { appRoot, adoptLegacyRoot, rootAliases } = require('../src/app-paths.cjs');

test('Mac profiles survive app moves and development builds', () => {
  const appData = path.resolve('fixture/Library/Application Support');
  for (const isPackaged of [false, true]) for (const location of ['Applications', 'Volumes/Read Only', 'AppTranslocation/random']) {
    const root = appRoot({ platform: 'darwin', appData, isPackaged, executablePath: path.resolve(location, 'Dirth.app/Contents/MacOS/Dirth'), sourceRoot: path.resolve('checkout') });
    assert.equal(root, path.join(appData, 'Dirth'));
  }
});

test('Windows keeps existing portable roots and QA overrides isolate both platforms', () => {
  const sourceRoot = path.resolve('checkout');
  const executablePath = path.join(sourceRoot, 'App', 'Dirth.exe');
  for (const isPackaged of [false, true]) assert.equal(appRoot({ platform: 'win32', isPackaged, executablePath, sourceRoot }), sourceRoot);
  for (const platform of ['darwin', 'win32']) {
    const testRoot = path.resolve('isolated QA');
    assert.equal(appRoot({ platform, testRoot }), testRoot);
    assert.throws(() => appRoot({ platform, testRoot: 'relative' }), /absolute/);
  }
});

function withAppData(run) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'dirth-app-data-'));
  try { return run(appData, path.join(appData, 'Dirth'), path.join(appData, 'Grokbuild Tokyo')); }
  finally { fs.rmSync(appData, { recursive: true, force: true }); }
}

function writeLegacyProfile(legacy) {
  fs.mkdirSync(path.join(legacy, 'data', 'browser'), { recursive: true });
  fs.mkdirSync(path.join(legacy, 'Workspace', 'project'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'data', 'conversations.json'), '{"saved":true}');
}

// Creating directory links needs extra rights on Windows; the Mac behaviour is what matters.
const linkTest = process.platform === 'win32' ? test.skip : test;

linkTest('Mac data saved as Grokbuild Tokyo moves to Dirth and the old path still resolves', () => withAppData((appData, root, legacy) => {
  writeLegacyProfile(legacy);
  assert.deepEqual(adoptLegacyRoot(root, { platform: 'darwin', appData }), { root, movedFrom: legacy });
  assert.equal(fs.readFileSync(path.join(root, 'data', 'conversations.json'), 'utf8'), '{"saved":true}');
  assert.ok(fs.lstatSync(legacy).isSymbolicLink());
  assert.equal(fs.realpathSync(path.join(legacy, 'Workspace', 'project')), fs.realpathSync(path.join(root, 'Workspace', 'project')));
  // The next launch finds Dirth in place and leaves the link alone.
  assert.deepEqual(adoptLegacyRoot(root, { platform: 'darwin', appData }), { root, movedFrom: null });
  assert.ok(fs.lstatSync(legacy).isSymbolicLink());
}));

test('An existing Dirth folder wins and the old folder is left untouched', () => withAppData((appData, root, legacy) => {
  writeLegacyProfile(legacy);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  assert.deepEqual(adoptLegacyRoot(root, { platform: 'darwin', appData }), { root, movedFrom: null });
  assert.ok(fs.lstatSync(legacy).isDirectory());
  assert.ok(fs.existsSync(path.join(legacy, 'data', 'conversations.json')));
  assert.ok(!fs.existsSync(path.join(root, 'data', 'conversations.json')));
}));

test('A first launch with no earlier data starts in the Dirth folder', () => withAppData((appData, root, legacy) => {
  assert.deepEqual(adoptLegacyRoot(root, { platform: 'darwin', appData }), { root, movedFrom: null });
  assert.ok(!fs.existsSync(legacy));
  assert.ok(!fs.existsSync(root));
}));

test('When the old folder cannot be moved the app keeps using it instead of starting empty', () => withAppData((appData, root, legacy) => {
  writeLegacyProfile(legacy);
  const failingFs = { ...fs, renameSync: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } };
  assert.deepEqual(adoptLegacyRoot(root, { platform: 'darwin', appData, fs: failingFs }), { root: legacy, movedFrom: null });
  assert.ok(fs.lstatSync(legacy).isDirectory());
}));

test('When the link cannot be made the folder goes back, so saved paths keep resolving', () => withAppData((appData, root, legacy) => {
  writeLegacyProfile(legacy);
  const noLinks = { ...fs, symlinkSync: () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); } };
  assert.deepEqual(adoptLegacyRoot(root, { platform: 'darwin', appData, fs: noLinks }), { root: legacy, movedFrom: null });
  assert.ok(fs.lstatSync(legacy).isDirectory());
  assert.ok(fs.existsSync(path.join(legacy, 'data', 'conversations.json')));
  assert.ok(!fs.existsSync(root));
}));

test('If neither the link nor the way back works, the moved data is used', () => withAppData((appData, root, legacy) => {
  writeLegacyProfile(legacy);
  let renames = 0;
  const stuck = { ...fs,
    symlinkSync: () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); },
    renameSync: (from, to) => { if (++renames > 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); fs.renameSync(from, to); } };
  assert.deepEqual(adoptLegacyRoot(root, { platform: 'darwin', appData, fs: stuck }), { root, movedFrom: legacy });
  assert.ok(fs.existsSync(path.join(root, 'data', 'conversations.json')));
}));

test('A launch that loses the move to another first launch uses the moved folder', () => withAppData((appData, root, legacy) => {
  writeLegacyProfile(legacy);
  const raced = { ...fs, renameSync: (from, to) => { fs.renameSync(from, to); fs.symlinkSync(to, from, 'dir'); throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } };
  assert.deepEqual(adoptLegacyRoot(root, { platform: 'darwin', appData, fs: raced }), { root, movedFrom: null });
}));

linkTest('While an older build still runs, its folder stays where it is', () => withAppData((appData, root, legacy) => {
  writeLegacyProfile(legacy);
  // Chromium's profile lock: a link naming the host and the owner's pid.
  const lock = path.join(legacy, 'data', 'browser', 'SingletonLock');
  fs.symlinkSync(`${os.hostname()}-${process.pid}`, lock);
  assert.deepEqual(adoptLegacyRoot(root, { platform: 'darwin', appData }), { root: legacy, movedFrom: null });
  assert.ok(fs.lstatSync(legacy).isDirectory());
  assert.ok(!fs.existsSync(root));
  // A lock left behind by a process that has exited does not stop the move.
  const exited = spawnSync(process.execPath, ['-e', '']).pid;
  fs.unlinkSync(lock);
  fs.symlinkSync(`${os.hostname()}-${exited}`, lock);
  assert.deepEqual(adoptLegacyRoot(root, { platform: 'darwin', appData }), { root, movedFrom: legacy });
}));

test('Windows roots, QA roots and custom roots are never moved', () => withAppData((appData, root, legacy) => {
  writeLegacyProfile(legacy);
  assert.deepEqual(adoptLegacyRoot(root, { platform: 'win32', appData }), { root, movedFrom: null });
  const testRoot = path.join(appData, 'QA');
  assert.deepEqual(adoptLegacyRoot(testRoot, { platform: 'darwin', appData, testRoot }), { root: testRoot, movedFrom: null });
  const elsewhere = path.join(appData, 'nested', 'Dirth');
  assert.deepEqual(adoptLegacyRoot(elsewhere, { platform: 'darwin', appData }), { root: elsewhere, movedFrom: null });
  assert.ok(fs.lstatSync(legacy).isDirectory());
}));

linkTest('Data a build named Akari moved is found, along with the link it left at Grokbuild Tokyo', () => withAppData((appData, root, legacy) => {
  // What a build of the rename branch did while the app was called Akari.
  const akari = path.join(appData, 'Akari');
  writeLegacyProfile(legacy);
  fs.renameSync(legacy, akari);
  fs.symlinkSync(akari, legacy, 'dir');
  assert.deepEqual(adoptLegacyRoot(root, { platform: 'darwin', appData }), { root, movedFrom: akari });
  assert.equal(fs.readFileSync(path.join(root, 'data', 'conversations.json'), 'utf8'), '{"saved":true}');
  // Both earlier names still lead to the same folder, and both count as its aliases.
  for (const name of [akari, legacy]) assert.equal(fs.realpathSync(path.join(name, 'Workspace', 'project')), fs.realpathSync(path.join(root, 'Workspace', 'project')));
  assert.deepEqual(rootAliases(root, { platform: 'darwin', appData }).sort(), [akari, legacy].sort());
}));

linkTest('An old folder that is a link to another disk moves as a link; a link to nothing is ignored', () => withAppData((appData, root, legacy) => {
  const elsewhere = path.join(appData, 'External disk', 'Grokbuild Tokyo');
  writeLegacyProfile(elsewhere);
  fs.symlinkSync(elsewhere, legacy, 'dir');
  assert.deepEqual(adoptLegacyRoot(root, { platform: 'darwin', appData }), { root, movedFrom: legacy });
  assert.ok(fs.lstatSync(root).isSymbolicLink(), 'the data stays on the other disk');
  assert.equal(fs.realpathSync(root), fs.realpathSync(elsewhere));
  assert.equal(fs.readFileSync(path.join(legacy, 'data', 'conversations.json'), 'utf8'), '{"saved":true}');
  assert.deepEqual(rootAliases(root, { platform: 'darwin', appData }), [legacy]);

  fs.rmSync(root);
  fs.rmSync(legacy);
  fs.symlinkSync(path.join(appData, 'Deleted'), legacy, 'dir');
  assert.deepEqual(adoptLegacyRoot(root, { platform: 'darwin', appData }), { root, movedFrom: null });
  assert.ok(!fs.existsSync(root));
  assert.ok(fs.lstatSync(legacy).isSymbolicLink());
}));

linkTest('Only earlier names that lead to the data folder are its aliases', () => withAppData((appData, root, legacy) => {
  fs.mkdirSync(root);
  assert.deepEqual(rootAliases(root, { platform: 'darwin', appData }), [], 'no earlier folder');
  writeLegacyProfile(legacy);
  assert.deepEqual(rootAliases(root, { platform: 'darwin', appData }), [], 'a separate old folder is not this one');
  fs.rmSync(legacy, { recursive: true });
  fs.symlinkSync(root, legacy, 'dir');
  assert.deepEqual(rootAliases(root, { platform: 'darwin', appData }), [legacy]);
  assert.deepEqual(rootAliases(legacy, { platform: 'darwin', appData }), [], 'the folder in use is not its own alias');
  assert.deepEqual(rootAliases(root, { platform: 'win32', appData }), []);
  assert.deepEqual(rootAliases(root, { platform: 'darwin', appData, testRoot: root }), []);
}));
