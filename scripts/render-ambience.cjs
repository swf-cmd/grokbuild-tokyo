'use strict';

// Rebuild the original soundtrack: node scripts/render-ambience.cjs
// Runs the score in a hidden Electron window; no audio device, downloads or API.
if (process.versions.electron) {
  const { app, BrowserWindow } = require('electron');
  app.whenReady().then(() => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    window.loadURL('data:text/html,<title>Tokyo soundtrack renderer</title>');
  });
} else {
  const { _electron } = require('playwright');
  const fs = require('node:fs');
  const path = require('node:path');
  (async () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const desktop = await _electron.launch({ args: [__filename], env });
    try {
      const page = await desktop.firstWindow();
      await page.addScriptTag({ path: path.join(__dirname, 'ambient-score.js') });
      const result = await page.evaluate(async () => {
        const began = performance.now();
        const { buffer, peak, rms } = await window.renderTokyoAfterimage();
        const bytes = new Uint8Array(44 + buffer.length * 4);
        const view = new DataView(bytes.buffer);
        const tag = (text, offset) => [...text].forEach((letter, index) => bytes[offset + index] = letter.charCodeAt(0));
        tag('RIFF', 0); view.setUint32(4, bytes.length - 8, true); tag('WAVEfmt ', 8);
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
        view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * 4, true);
        view.setUint16(32, 4, true); view.setUint16(34, 16, true); tag('data', 36); view.setUint32(40, buffer.length * 4, true);
        const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
        for (let index = 0; index < buffer.length; index++) {
          view.setInt16(44 + index * 4, Math.round(Math.max(-1, Math.min(1, left[index])) * 32767), true);
          view.setInt16(46 + index * 4, Math.round(Math.max(-1, Math.min(1, right[index])) * 32767), true);
        }
        const chunks = [];
        for (let index = 0; index < bytes.length; index += 32768) chunks.push(String.fromCharCode(...bytes.subarray(index, index + 32768)));
        return { encoded: btoa(chunks.join('')), durationSeconds: buffer.duration, peak, rms,
          renderSeconds: (performance.now() - began) / 1000,
          seamDeltas: [left, right].map(samples => Math.abs(samples[0] - samples[samples.length - 1])) };
      });
      const outputFlag = process.argv.indexOf('--output');
      const output = outputFlag >= 0 && process.argv[outputFlag + 1]
        ? path.resolve(process.argv[outputFlag + 1])
        : path.join(__dirname, '../src/renderer/assets/tokyo-afterimage.wav');
      fs.writeFileSync(output, Buffer.from(result.encoded, 'base64'));
      delete result.encoded;
      console.log(JSON.stringify({ output, ...result }, null, 2));
    } finally { await desktop.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
