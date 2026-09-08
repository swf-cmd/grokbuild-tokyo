'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/ambient-audio.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const calls = { fetch: 0, decode: 0, start: 0, resume: 0, sampleReads: 0 };
  const contexts = [];
  const timers = new Map();
  let nextTimer = 0;
  let resolveDecode, rejectDecode;
  const frames = 44100 * 96;
  const samples = new Proxy({ length: frames }, {
    get(target, property) {
      if (property === 'length') return target.length;
      calls.sampleReads++;
      return 0.1;
    },
  });
  const buffer = { numberOfChannels: 2, duration: 96, length: frames, sampleRate: 44100, getChannelData: () => samples };
  class AudioContext {
    constructor(options) { this.options = options; this.state = 'suspended'; this.currentTime = 0; contexts.push(this); }
    createGain() {
      return { gain: { value: 0, cancelAndHoldAtTime() {}, setTargetAtTime() {} }, connect() {}, disconnect() {} };
    }
    createBufferSource() {
      return { connect() {}, disconnect() {}, stop() {}, start() { calls.start++; } };
    }
    decodeAudioData() {
      calls.decode++;
      return new Promise((resolve, reject) => { resolveDecode = resolve; rejectDecode = reject; });
    }
    async resume() { calls.resume++; this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
    async close() { this.state = 'closed'; }
  }
  const window = {
    AudioContext,
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener() {}, removeEventListener() {},
  };
  vm.runInNewContext(source, {
    window, document: { baseURI: 'file:///app/src/renderer/index.html' }, URL, Float32Array,
    fetch: async () => { calls.fetch++; return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }; },
  });
  const player = window.TokyoAmbience.create();
  return {
    player, calls, contexts,
    complete: () => resolveDecode(buffer),
    fail: () => rejectDecode(new Error('Fixture decode failed')),
    finishPause() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); },
  };
}

test('enabled music starts automatically without a gesture and later gestures do not restart it', async t => {
  const { player, calls, contexts, complete } = fixture();
  t.after(() => player.dispose());
  player.setPreferences({ musicEnabled: true, musicVolume: 90 });
  await settle();
  assert.equal(calls.decode, 1, 'start loading without a click');
  assert.equal(calls.resume, 1, 'resume automatically while decoding');
  assert.equal(calls.start, 0);
  assert.equal(contexts[0].options.sampleRate, 44100);
  complete();
  await settle();
  assert.equal(player.getStatus().state, 'playing');
  await player.unlock();
  await player.unlock();
  assert.equal(calls.fetch, 1);
  assert.equal(calls.decode, 1);
  assert.equal(calls.start, 1);
  assert.ok(calls.sampleReads < 250000, 'diagnostic metering must not scan the full 96-second track');
  assert.ok(Math.abs(player.getStatus().rms - 0.1) < 0.00001);
});

test('disabled or muted music does not load, and disabling during preparation keeps it silent', async t => {
  const { player, calls, contexts, complete, finishPause } = fixture();
  t.after(() => player.dispose());
  player.setPreferences({ musicEnabled: false });
  await player.unlock();
  player.setPreferences({ musicEnabled: true, musicVolume: 0 });
  await player.unlock();
  await settle();
  assert.equal(contexts.length, 0);
  assert.equal(calls.fetch, 0);
  player.setPreferences({ musicVolume: 20 });
  await settle();
  player.setPreferences({ musicEnabled: false });
  complete();
  await settle();
  assert.equal(calls.start, 0);
  assert.equal(player.getStatus().state, 'paused');
  finishPause();
  await settle();
  assert.equal(contexts[0].state, 'suspended');
});

test('gestures and volume changes during automatic preparation share one decode and source', async t => {
  const { player, calls, complete } = fixture();
  t.after(() => player.dispose());
  player.setPreferences({ musicEnabled: true });
  await settle();
  await player.unlock();
  player.setPreferences({ musicVolume: 60 });
  await player.unlock();
  complete();
  await settle();
  assert.equal(player.getStatus().state, 'playing');
  assert.equal(player.getStatus().musicVolume, 60);
  assert.equal(calls.fetch, 1);
  assert.equal(calls.decode, 1);
  assert.equal(calls.start, 1);
});

test('a failed preparation can be retried by the first gesture', async t => {
  const { player, calls, complete, fail } = fixture();
  t.after(() => player.dispose());
  player.setPreferences({ musicEnabled: true });
  await settle();
  fail();
  await settle();
  const activation = player.unlock();
  await settle();
  assert.equal(calls.decode, 2);
  complete();
  await activation;
  assert.equal(calls.start, 1);
  assert.equal(player.getStatus().state, 'playing');
});

test('disposing during preparation discards the decoded track without starting audio', async () => {
  const { player, calls, contexts, complete } = fixture();
  player.setPreferences({ musicEnabled: true });
  await settle();
  player.dispose();
  complete();
  await settle();
  assert.equal(calls.start, 0);
  assert.equal(contexts[0].state, 'closed');
  assert.equal(player.getStatus().ready, false);
});
