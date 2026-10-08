// @ts-check
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options, FuseState } = require('@electron/fuses');

// Applied after packaging/universal merging and before the final code signature.
// Packager embeds the matching ASAR integrity metadata for Windows and macOS.
const releaseFuses = Object.freeze({
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
});

function fuseTarget(build, platform) {
  return path.join(build, platform === 'darwin' ? 'Grokbuild Tokyo.app' : 'Grokbuild Tokyo.exe');
}

async function verifyReleaseFuses(binary) {
  const wire = await getCurrentFuseWire(binary);
  assert.equal(wire.version, FuseVersion.V1, 'Unexpected Electron fuse version');
  for (const [key, enabled] of Object.entries(releaseFuses)) {
    if (key === 'version') continue;
    assert.equal(wire[key], enabled ? FuseState.ENABLE : FuseState.DISABLE, `Incorrect release fuse ${FuseV1Options[key]}`);
  }
}

async function hardenPackagedBuild(build, platform) {
  const binary = fuseTarget(build, platform);
  await flipFuses(binary, releaseFuses);
  await verifyReleaseFuses(binary);
}

module.exports = { releaseFuses, fuseTarget, verifyReleaseFuses, hardenPackagedBuild };
