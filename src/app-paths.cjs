'use strict';
const path = require('node:path');

function appRoot({ platform = process.platform, testRoot, appData, isPackaged, executablePath, sourceRoot }) {
  if (testRoot) {
    if (!path.isAbsolute(testRoot)) throw new Error('TOKYO_TEST_ROOT must be an absolute path');
    return testRoot;
  }
  // A .app may be read-only or translocated. Data must survive moving/updating it.
  if (platform === 'darwin') return path.join(appData, 'Grokbuild Tokyo');
  return isPackaged ? path.resolve(path.dirname(executablePath), '..') : sourceRoot;
}

module.exports = { appRoot };
