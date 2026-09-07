'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { packageFiles } = require('./package-policy.cjs');
(async () => {
  const asar = await import('@electron/asar');
  const archive = path.resolve(__dirname, '../App/resources/app.asar');
  const contents = asar.listPackage(archive).map(file => file.replace(/\\/g, '/').replace(/^\//, ''));
  const unexpected = contents.filter(file => !packageFiles.includes(file) && !packageFiles.some(allowed => allowed.startsWith(file + '/')));
  assert.deepEqual(unexpected, [], 'Unexpected files in app.asar');
  assert.deepEqual(packageFiles.filter(file => !contents.includes(file)), [], 'Missing runtime files');
  console.log(`PASS package inventory: ${packageFiles.length} allowed files, no unexpected files`);
})().catch(error => { console.error(error); process.exitCode = 1; });
