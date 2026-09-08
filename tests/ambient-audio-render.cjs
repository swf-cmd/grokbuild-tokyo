'use strict';

// Run: node tests/ambient-audio-render.cjs [--packaged]
// Render the actual player and WAV through Electron's native Web Audio graph.
// Only the realtime context lifecycle is adapted; decoding, automation, gain,
// source looping and any accidentally reintroduced effects remain native.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const sourceRoot = process.argv.includes('--packaged')
  ? require('../scripts/package-paths.cjs').packagedArchive(root) : root;
const base = path.join(root, 'work', 'ambient-audio-qa');
fs.mkdirSync(base, { recursive: true });
const output = fs.mkdtempSync(path.join(base, 'run-'));
const env = { ...process.env, TOKYO_AUDIO_TEST_ROOT: output, TOKYO_AUDIO_SOURCE_ROOT: sourceRoot };
delete env.ELECTRON_RUN_AS_NODE;
const results = [];

(async () => {
  const desktop = await _electron.launch({ args: [path.join(__dirname, 'fixtures', 'ambient-audio-app.cjs')], env });
  try {
    const page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => {
      window.__audioRender = { contexts: [] };
      window.AudioContext = class OfflinePlaybackContext {
        constructor(options) {
          this.offline = new OfflineAudioContext(2, options.sampleRate * 97, options.sampleRate);
          this.state = 'suspended';
          window.__audioRender.contexts.push(this);
        }
        get currentTime() { return this.offline.currentTime; }
        get destination() { return this.offline.destination; }
        createGain() { return this.offline.createGain(); }
        createWaveShaper() { return this.offline.createWaveShaper(); }
        createBufferSource() { return this.offline.createBufferSource(); }
        async decodeAudioData(bytes) { return (this.decoded = await this.offline.decodeAudioData(bytes)); }
        async resume() { this.state = 'running'; }
        async suspend() { this.state = 'suspended'; }
        async close() { this.state = 'closed'; }
      };
    });
    await page.addScriptTag({ url: pathToFileURL(path.join(sourceRoot, 'src', 'renderer', 'ambient-audio.js')).href });
    for (const volume of [90, 100]) {
      const result = await page.evaluate(async volume => {
        let ready, failed;
        const playing = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
        const deadline = setTimeout(() => failed(new Error('Automatic playback timed out')), 10000);
        const player = window.TokyoAmbience.create({ onStatus(status) {
          if (status.state === 'playing') ready();
          else if (status.state === 'error') failed(new Error(status.error));
        } });
        try {
          player.setPreferences({ musicEnabled: true, musicVolume: volume });
          await playing;
          const status = player.getStatus();
          if (status.state !== 'playing') throw new Error(`Player failed: ${JSON.stringify(status)}`);
          const context = window.__audioRender.contexts.at(-1);
          const input = context.decoded;
          const rendered = await context.offline.startRendering();
          const gain = volume / 100 * 1.50;
          const settledFrame = 8 * input.sampleRate;
          let sourcePeak = 0, outputPeak = 0, clippedSamples = 0, nonFiniteSamples = 0;
          let maxSteadyError = 0, maxLoopError = 0, errorSquares = 0, signalSquares = 0;
          for (let channel = 0; channel < input.numberOfChannels; channel++) {
            const dry = input.getChannelData(channel);
            const wet = rendered.getChannelData(channel);
            for (let index = 0; index < dry.length; index++) sourcePeak = Math.max(sourcePeak, Math.abs(dry[index]));
            for (let index = 0; index < wet.length; index++) {
              const value = wet[index];
              if (!Number.isFinite(value)) nonFiniteSamples++;
              outputPeak = Math.max(outputPeak, Math.abs(value));
              if (Math.abs(value) >= 1) clippedSamples++;
              if (index < settledFrame) continue;
              const expected = dry[index % dry.length] * gain;
              const error = value - expected;
              maxSteadyError = Math.max(maxSteadyError, Math.abs(error));
              errorSquares += error * error;
              signalSquares += expected * expected;
              if (index >= dry.length) maxLoopError = Math.max(maxLoopError, Math.abs(error));
            }
          }
          return {
            volume, sourceSeconds: input.duration, renderedSeconds: rendered.duration,
            channels: input.numberOfChannels, sampleRate: input.sampleRate,
            gain, sourcePeak, outputPeak, clippedSamples, nonFiniteSamples,
            maxSteadyError, maxLoopError,
            relativeErrorDb: 10 * Math.log10(Math.max(errorSquares, Number.MIN_VALUE) / signalSquares),
          };
        } finally { clearTimeout(deadline); player.dispose(); }
      }, volume);
      results.push(result);
      assert.equal(result.sourceSeconds, 96);
      assert.equal(result.renderedSeconds, 97, 'render the complete track and the next loop seam');
      assert.equal(result.channels, 2);
      assert.equal(result.sampleRate, 44100);
      assert.equal(result.nonFiniteSamples, 0);
      assert.equal(result.clippedSamples, 0, `${volume}% volume must not clip`);
      assert.ok(result.outputPeak < 0.98, `${volume}% volume must retain output headroom`);
      assert.ok(result.outputPeak > 0.1, 'the clipping test must not pass with silent output');
      assert.ok(result.maxSteadyError < 0.000002, `preserve the source waveform: ${JSON.stringify(result)}`);
      assert.ok(result.maxLoopError < 0.000002, 'native looping must preserve sample order across the seam');
      console.log(`PASS ${volume}% volume: ${JSON.stringify(result)}`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await desktop.close();
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ packagedResources: process.argv.includes('--packaged'), results }, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
