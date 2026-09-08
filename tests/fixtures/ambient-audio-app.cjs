'use strict';

// A silent, hidden renderer for real Web Audio tests. Never load the app main,
// preload, settings, or CLI, and keep all Electron state in the test directory.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
const profile = process.env.TOKYO_AUDIO_TEST_ROOT;
const sourceRoot = process.env.TOKYO_AUDIO_SOURCE_ROOT;
if (!profile || !path.isAbsolute(profile) || !sourceRoot || !path.isAbsolute(sourceRoot)) {
  throw new Error('Absolute, isolated audio test paths are required');
}
app.setPath('userData', path.join(profile, 'profile'));
app.commandLine.appendSwitch('mute-audio');
const entry = path.join(profile, 'index.html');
const base = pathToFileURL(path.join(sourceRoot, 'src', 'renderer') + path.sep).href;
fs.writeFileSync(entry, `<!doctype html><html><head><meta charset="utf-8"><base href="${base}"><title>Offline audio regression</title></head><body></body></html>`);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  window.webContents.setAudioMuted(true);
  await window.loadFile(entry);
});
app.on('window-all-closed', () => app.quit());
