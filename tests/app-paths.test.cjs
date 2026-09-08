'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { appRoot } = require('../src/app-paths.cjs');

test('Mac profiles survive app moves and development builds', () => {
  const appData = path.resolve('fixture/Library/Application Support');
  for (const isPackaged of [false, true]) for (const location of ['Applications', 'Volumes/Read Only', 'AppTranslocation/random']) {
    const root = appRoot({ platform: 'darwin', appData, isPackaged, executablePath: path.resolve(location, 'Tokyo.app/Contents/MacOS/Tokyo'), sourceRoot: path.resolve('checkout') });
    assert.equal(root, path.join(appData, 'Grokbuild Tokyo'));
  }
});

test('Windows keeps existing portable roots and QA overrides isolate both platforms', () => {
  const sourceRoot = path.resolve('checkout');
  const executablePath = path.join(sourceRoot, 'App', 'Tokyo.exe');
  for (const isPackaged of [false, true]) assert.equal(appRoot({ platform: 'win32', isPackaged, executablePath, sourceRoot }), sourceRoot);
  for (const platform of ['darwin', 'win32']) {
    const testRoot = path.resolve('isolated QA');
    assert.equal(appRoot({ platform, testRoot }), testRoot);
    assert.throws(() => appRoot({ platform, testRoot: 'relative' }), /absolute/);
  }
});
