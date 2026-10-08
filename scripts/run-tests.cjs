// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseTarget } = require('./package-config.cjs');
const root = path.resolve(__dirname, '..');

// The same fixture suite validates source and packaged ASAR resources. These
// tests never select --live or enable the opt-in tests that use real accounts.
const uiTests = [
  'tests/ui-controls.cjs', 'tests/ui-security.cjs', 'scripts/images-accounts-smoke.cjs',
  'tests/ui-attachments.cjs', 'tests/i18n-ui.cjs', 'tests/startup-ui.cjs',
  'tests/model-refresh-ui.cjs', 'tests/onboarding-ui.cjs',
  'tests/ambient-audio-render.cjs', 'tests/time-ui.cjs', 'tests/renderer-performance.cjs',
];

function packageBin(name, command) {
  const manifest = require.resolve(name + '/package.json');
  const bin = require(manifest).bin;
  return path.resolve(path.dirname(manifest), typeof bin === 'string' ? bin : bin[command]);
}

function testCommands(argv = []) {
  const packaged = argv.includes('--packaged');
  const targetArgs = argv.filter(arg => !['--packaged', '--list'].includes(arg));
  if (!packaged && targetArgs.length) throw new Error('Usage: npm run test:all [-- --list]');
  if (packaged) parseTarget(targetArgs);
  if (packaged) return [
    ['scripts/verify-package.cjs', ...targetArgs],
    ['scripts/packaged-launch-smoke.cjs'],
    ...uiTests.map(file => [file, '--packaged']),
  ];
  return [
    [packageBin('eslint', 'eslint'), '.'],
    [packageBin('typescript', 'tsc'), '--project', 'tsconfig.json'],
    ['--test', ...fs.readdirSync(path.join(root, 'tests')).filter(file => file.endsWith('.test.cjs')).sort().map(file => path.join('tests', file))],
    ...uiTests.map(file => [file]),
  ];
}

if (require.main === module) {
  const commands = testCommands(process.argv.slice(2));
  for (const args of commands) {
    console.log(`\n> node ${args.join(' ')}`);
    if (process.argv.includes('--list')) continue;
    const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, stdio: 'inherit', timeout: 300000 });
    if (result.error || result.status !== 0) {
      if (result.error) console.error(result.error);
      process.exitCode = result.status || 1;
      break;
    }
  }
}

module.exports = { testCommands, uiTests };
