'use strict';

// Rebuild the original soundtracks:
//   node scripts/render-ambience.cjs                   Tokyo Afterimage
//   node scripts/render-ambience.cjs --theme kyoto     one city
//   node scripts/render-ambience.cjs --theme all       every city
// Runs the scores in a hidden Electron window; no audio device, downloads or API.
// The tracks are encoded as lossless FLAC with ffmpeg (it must be on PATH);
// --output file.wav writes the uncompressed render instead.
if (process.versions.electron) {
  const { app, BrowserWindow } = require('electron');
  app.whenReady().then(() => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    window.loadURL('data:text/html,<title>City soundtrack renderer</title>');
  });
} else {
  const { _electron } = require('playwright');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const vm = require('node:vm');
  const { execFileSync } = require('node:child_process');
  const assets = path.join(__dirname, '../src/renderer/assets');
  const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
  // Track files and lengths come from the player itself.
  const sandbox = { window: { addEventListener() {} }, document: { baseURI: 'file:///renderer/index.html' }, URL };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/ambient-audio.js'), 'utf8'), sandbox);
  const tracks = sandbox.window.TokyoAmbience.tracks;
  const requested = option('--theme') || 'tokyo';
  const themes = requested === 'all' ? Object.keys(tracks) : [requested];
  if (!themes.every(theme => Object.hasOwn(tracks, theme))) throw new Error(`Unknown theme: ${requested}`);
  (async () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const desktop = await _electron.launch({ args: [__filename], env });
    try {
      const page = await desktop.firstWindow();
      await page.addScriptTag({ path: path.join(__dirname, 'ambient-score.js') });
      await page.addScriptTag({ path: path.join(__dirname, 'theme-scores.js') });
      for (const theme of themes) {
        const result = await page.evaluate(async theme => {
          const began = performance.now();
          const { buffer, peak, rms } = theme === 'tokyo' ? await window.renderTokyoAfterimage() : await window.renderThemeScore(theme);
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
        }, theme);
        if (Math.abs(result.durationSeconds - tracks[theme].duration) > 0.01) throw new Error(`${theme} rendered ${result.durationSeconds} s, expected ${tracks[theme].duration} s`);
        const wav = Buffer.from(result.encoded, 'base64');
        delete result.encoded;
        const custom = option('--output');
        const destination = custom ? path.resolve(custom) : path.join(assets, tracks[theme].file);
        if (destination.endsWith('.flac')) {
          const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'city-score-'));
          try {
            const input = path.join(scratch, `${theme}.wav`);
            fs.writeFileSync(input, wav);
            execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-c:a', 'flac', '-compression_level', '12', destination]);
          } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
        } else fs.writeFileSync(destination, wav);
        console.log(JSON.stringify({ theme, output: destination, bytes: fs.statSync(destination).size, ...result }, null, 2));
      }
    } finally { await desktop.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
