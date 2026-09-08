'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function executableName(platform = process.platform) {
  return platform === 'win32' ? 'grok.exe' : 'grok';
}

function defaultExecutable(home = os.homedir(), platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return paths.join(home, '.grok', 'bin', executableName(platform));
}

function isExecutable(file, platform = process.platform) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  if (platform === 'win32' && path.extname(file).toLowerCase() !== '.exe') return false;
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function cliEnvironment(env = process.env, { home = os.homedir(), platform = process.platform, executable } = {}) {
  const result = { ...env };
  if (platform !== 'darwin') return result;
  // Finder-launched apps do not inherit a login shell's PATH. Keep explicit
  // entries in their original order, then supply common user and Homebrew bins.
  // Do not source shell configuration or execute shell commands during startup.
  const bins = [
    ...(result.PATH || '').split(':'),
    ...(typeof executable === 'string' && path.isAbsolute(executable) ? [path.dirname(executable)] : []),
    ...['.grok/bin', '.local/bin', '.cargo/bin', '.bun/bin', 'bin'].map(bin => path.join(home, bin)),
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ];
  result.PATH = [...new Set(bins.filter(Boolean))].join(':');
  return result;
}

function findGrokExecutable({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const fallback = defaultExecutable(home, platform);
  if (isExecutable(fallback, platform)) return fallback;
  const environment = cliEnvironment(env, { home, platform });
  const pathKey = platform === 'win32' ? Object.keys(environment).find(key => key.toUpperCase() === 'PATH') : 'PATH';
  const paths = platform === 'win32' ? path.win32 : path.posix;
  for (const bin of (environment[pathKey] || '').split(platform === 'win32' ? ';' : ':')) {
    // Relative PATH entries depend on a terminal's working directory and are
    // unsuitable for selecting a persistent executable from a desktop app.
    if (!paths.isAbsolute(bin)) continue;
    const candidate = paths.join(bin, executableName(platform));
    if (isExecutable(candidate, platform)) return candidate;
  }
  return fallback;
}

module.exports = { executableName, defaultExecutable, isExecutable, cliEnvironment, findGrokExecutable };
