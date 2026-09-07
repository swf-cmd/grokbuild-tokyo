/*
 * Tokyo Afterimage — an original, locally synthesized instrumental.
 * 80 BPM · 32 bars / 96 seconds · no recordings, samples or network requests.
 * An offline render includes the preceding eight bars, so reverb, delay and
 * sustained notes already cross the loop seam. Playback uses the audio thread,
 * not a JavaScript note scheduler, and continues when the window is minimized.
 */
(() => {
  'use strict';

  const BPM = 80;
  const BEAT = 60 / BPM;
  const BAR = BEAT * 4;
  const BARS = 32;
  const DURATION = BAR * BARS;
  const PREROLL_BARS = 8;
  const SAMPLE_RATE = 44100;
  const TITLE = 'Tokyo Afterimage · 東京残像';

  const midiHz = midi => 440 * Math.pow(2, (midi - 69) / 12);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const random = seed => {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  };

  async function renderComposition() {
    const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineContext) throw new Error('此设备不支持背景音乐合成');
    const preroll = PREROLL_BARS * BAR;
    const offline = new OfflineContext(2, Math.round((DURATION + preroll) * SAMPLE_RATE), SAMPLE_RATE);
    const gain = (value, destination) => {
      const node = offline.createGain();
      node.gain.value = value;
      if (destination) node.connect(destination);
      return node;
    };
    const filter = (type, frequency, destination) => {
      const node = offline.createBiquadFilter();
      node.type = type;
      node.frequency.value = frequency;
      node.Q.value = 0.55;
      if (destination) node.connect(destination);
      return node;
    };
    const pan = (value, destination) => {
      const node = offline.createStereoPanner();
      node.pan.value = value;
      node.connect(destination);
      return node;
    };
    const compressor = offline.createDynamicsCompressor();
    compressor.threshold.value = -19;
    compressor.knee.value = 15;
    compressor.ratio.value = 2.1;
    compressor.attack.value = 0.018;
    compressor.release.value = 0.26;
    compressor.connect(offline.destination);
    const mix = filter('lowpass', 8800, compressor);

    // Soft, dark room reverb; its fixed noise seed makes the score repeatable.
    const impulse = offline.createBuffer(2, Math.floor(SAMPLE_RATE * 3.5), SAMPLE_RATE);
    for (let channel = 0; channel < 2; channel++) {
      const samples = impulse.getChannelData(channel);
      const rng = random(8041 + channel * 109);
      let smooth = 0;
      for (let index = 0; index < samples.length; index++) {
        smooth = smooth * 0.61 + (rng() * 2 - 1) * 0.39;
        const seconds = index / SAMPLE_RATE;
        samples[index] = smooth * Math.exp(-seconds * 2.6) * Math.min(1, seconds / 0.018);
      }
    }
    const reverb = offline.createConvolver();
    reverb.buffer = impulse;
    reverb.connect(filter('lowpass', 4200, gain(0.28, mix)));

    const echoInput = gain(1);
    const echoLeft = offline.createDelay(1);
    const echoRight = offline.createDelay(1);
    echoLeft.delayTime.value = BEAT * 0.75;
    echoRight.delayTime.value = BEAT * 0.5;
    echoInput.connect(echoLeft);
    echoLeft.connect(pan(-0.55, gain(0.25, mix)));
    echoRight.connect(pan(0.55, gain(0.19, mix)));
    echoLeft.connect(filter('lowpass', 2400, gain(0.27, echoRight)));
    echoRight.connect(filter('lowpass', 2100, gain(0.27, echoLeft)));

    const keys = filter('lowpass', 4200, gain(0.75, mix));
    keys.connect(gain(0.18, reverb));
    keys.connect(gain(0.10, echoInput));
    const melody = filter('lowpass', 2400, gain(0.62, mix));
    melody.connect(gain(0.30, reverb));
    melody.connect(gain(0.36, echoInput));
    const bass = filter('lowpass', 510, mix);
    const drums = gain(0.72, mix);
    drums.connect(gain(0.045, reverb));

    const padBus = filter('lowpass', 1150);
    padBus.connect(gain(0.55, mix));
    padBus.connect(gain(0.40, reverb));
    for (const [position, seconds, rate] of [[-0.7, 0.019, 13], [0.7, 0.027, 17]]) {
      const chorus = offline.createDelay(0.06);
      chorus.delayTime.value = seconds;
      padBus.connect(chorus);
      chorus.connect(pan(position, gain(0.32, mix)));
      const modulation = offline.createOscillator();
      modulation.frequency.value = rate / DURATION;
      modulation.connect(gain(0.0035, chorus.delayTime));
      modulation.start(0);
    }

    const noise = offline.createBuffer(1, SAMPLE_RATE * 2, SAMPLE_RATE);
    const noiseSamples = noise.getChannelData(0);
    const noiseRng = random(19870416);
    for (let index = 0; index < noiseSamples.length; index++) noiseSamples[index] = noiseRng() * 2 - 1;

    function oscillator(type, frequency, time, end, destination, detune = 0, tape = false) {
      const node = offline.createOscillator();
      node.type = type;
      node.frequency.setValueAtTime(frequency, time);
      node.detune.value = detune;
      if (tape) {
        // Automation lets expired voices leave the rendering graph. Connecting
        // a shared LFO to every voice would keep thousands of inputs active.
        const wobble = seconds => detune + Math.sin(seconds * Math.PI * 2 * 19 / DURATION) * 3.1;
        node.detune.setValueAtTime(wobble(time), time);
        for (let point = time + 0.24; point < end; point += 0.24) {
          node.detune.linearRampToValueAtTime(wobble(point), point);
        }
        node.detune.linearRampToValueAtTime(wobble(end), end);
      }
      node.connect(destination);
      node.start(time);
      node.stop(end);
      return node;
    }

    function electricPiano(note, time, velocity, length, position) {
      const output = pan(position, keys);
      const fundamental = gain(0, output);
      fundamental.gain.setValueAtTime(0, time);
      fundamental.gain.linearRampToValueAtTime(velocity * 0.048, time + 0.009);
      fundamental.gain.exponentialRampToValueAtTime(velocity * 0.012, time + length * 0.65);
      fundamental.gain.exponentialRampToValueAtTime(0.00001, time + length + 0.32);
      oscillator('sine', midiHz(note), time, time + length + 0.34, fundamental, -1.7, true);
      const body = gain(0, output);
      body.gain.setValueAtTime(velocity * 0.012, time);
      body.gain.exponentialRampToValueAtTime(0.00001, time + 0.92);
      oscillator('sine', midiHz(note) * 2, time, time + 0.95, body, 2.2, true);
      const tine = gain(0, output);
      tine.gain.setValueAtTime(velocity * 0.007, time);
      tine.gain.exponentialRampToValueAtTime(0.00001, time + 0.20);
      oscillator('sine', midiHz(note) * 3.99, time, time + 0.22, tine, 0, true);
    }

    function pad(notes, time) {
      const envelope = gain(0, padBus);
      envelope.gain.setValueAtTime(0, time);
      envelope.gain.linearRampToValueAtTime(0.0105, time + 1.05);
      envelope.gain.setValueAtTime(0.0105, time + BAR * 2 - 0.36);
      envelope.gain.exponentialRampToValueAtTime(0.00001, time + BAR * 2 + 1.35);
      notes.forEach((note, index) => {
        const position = pan((index / (notes.length - 1) - 0.5) * 0.8, envelope);
        oscillator('triangle', midiHz(note - 12), time, time + BAR * 2 + 1.4, position, -5, true);
        oscillator('sawtooth', midiHz(note), time, time + BAR * 2 + 1.4, gain(0.27, position), 5, true);
      });
    }

    function bassNote(note, time, duration, velocity = 1) {
      const envelope = gain(0, bass);
      envelope.gain.setValueAtTime(0, time);
      envelope.gain.linearRampToValueAtTime(0.115 * velocity, time + 0.016);
      envelope.gain.exponentialRampToValueAtTime(0.06 * velocity, time + duration * 0.65);
      envelope.gain.exponentialRampToValueAtTime(0.00001, time + duration + 0.13);
      oscillator('triangle', midiHz(note), time, time + duration + 0.15, envelope);
      oscillator('sine', midiHz(note), time, time + duration + 0.15, gain(0.6, envelope));
    }

    function leadNote(note, time, duration, velocity = 1) {
      const envelope = gain(0, melody);
      envelope.gain.setValueAtTime(0, time);
      envelope.gain.linearRampToValueAtTime(0.038 * velocity, time + 0.035);
      envelope.gain.exponentialRampToValueAtTime(0.022 * velocity, time + duration * 0.65);
      envelope.gain.exponentialRampToValueAtTime(0.00001, time + duration + 0.30);
      const position = pan(0.12, envelope);
      oscillator('triangle', midiHz(note), time, time + duration + 0.33, position, -3, true);
      oscillator('sine', midiHz(note) * 2, time, time + duration + 0.33, gain(0.13, position), 3, true);
    }

    function percussionNoise(time, duration, level, frequency, position) {
      const envelope = gain(0, pan(position, drums));
      envelope.gain.setValueAtTime(level, time);
      envelope.gain.exponentialRampToValueAtTime(0.00001, time + duration);
      const tone = filter('highpass', frequency, envelope);
      const source = offline.createBufferSource();
      source.buffer = noise;
      source.connect(tone);
      source.start(time, (time * 0.137) % 1.5, duration + 0.01);
    }

    function kick(time, velocity = 1) {
      const envelope = gain(0, drums);
      envelope.gain.setValueAtTime(0, time);
      envelope.gain.linearRampToValueAtTime(0.20 * velocity, time + 0.004);
      envelope.gain.exponentialRampToValueAtTime(0.00001, time + 0.24);
      const tone = oscillator('sine', 105, time, time + 0.26, envelope);
      tone.frequency.exponentialRampToValueAtTime(46, time + 0.08);
    }

    function snare(time, velocity = 1) {
      percussionNoise(time, 0.14, 0.044 * velocity, 1500, -0.06);
      const envelope = gain(0, drums);
      envelope.gain.setValueAtTime(0.028 * velocity, time);
      envelope.gain.exponentialRampToValueAtTime(0.00001, time + 0.085);
      oscillator('triangle', 176, time, time + 0.09, envelope);
    }

    const harmony = [
      { root: 38, notes: [57, 61, 64, 66], tune: [76, 78, 76, 73] }, // Dmaj9
      { root: 37, notes: [56, 59, 64, 68], tune: [71, 76, 75, 71] }, // C#m7
      { root: 30, notes: [57, 61, 64, 68], tune: [73, 76, 80, 78] }, // F#m9
      { root: 35, notes: [57, 61, 62, 66], tune: [78, 76, 74, 73] }, // Bm9
      { root: 40, notes: [56, 61, 62, 66], tune: [71, 73, 78, 76] }, // E13
      { root: 33, notes: [56, 59, 61, 64], tune: [73, 71, 68, 64] }, // Amaj9
      { root: 31, notes: [54, 57, 59, 62], tune: [71, 74, 76, 78] }, // Gmaj9
      { root: 33, notes: [55, 59, 61, 66], tune: [73, 71, 67, 64] }, // A13
      { root: 38, notes: [57, 61, 64, 66], tune: [76, 78, 76, 73] },
      { root: 37, notes: [56, 59, 64, 68], tune: [71, 76, 75, 71] },
      { root: 30, notes: [57, 61, 64, 68], tune: [73, 76, 80, 78] },
      { root: 35, notes: [57, 61, 62, 66], tune: [78, 76, 74, 73] },
      { root: 32, notes: [54, 59, 62, 66], tune: [74, 73, 71, 66] }, // G#m7b5
      { root: 37, notes: [56, 59, 62, 65], tune: [74, 73, 71, 68] }, // C#7b9
      { root: 30, notes: [57, 61, 64, 68], tune: [73, 76, 73, 68] },
      { root: 33, notes: [55, 59, 61, 66], tune: [71, 73, 71, 69] }
    ];

    for (let index = -PREROLL_BARS; index < BARS; index++) {
      const bar = (index + BARS) % BARS;
      const start = (index + PREROLL_BARS) * BAR;
      const chord = harmony[Math.floor(bar / 2)];
      const rng = random(8020 + bar * 7919);
      const interlude = bar >= 16 && bar < 20;
      const sparse = bar < 4 || interlude;
      if (bar % 2 === 0) pad(chord.notes, start);

      const strikes = sparse ? [[0, 0.84], [2.5, 0.48]] : [[0, 0.86], [1.75, 0.46], [2.5, 0.64]];
      for (const [beat, velocity] of strikes) {
        chord.notes.forEach((note, voice) => {
          electricPiano(note, start + beat * BEAT + voice * 0.012 + rng() * 0.006,
            velocity * (0.94 + rng() * 0.12), BEAT * (beat === 0 ? 2.25 : 1.2), (voice - 1.5) * 0.13 - 0.12);
        });
      }
      bassNote(chord.root, start + 0.008, BEAT * 1.12, 0.9);
      bassNote(chord.root, start + BEAT * 1.5 + 0.023, BEAT * 0.7, 0.72);
      bassNote(chord.root + (bar % 2 ? 12 : 0), start + BEAT * 2.75 + 0.009, BEAT * 0.72, 0.72);
      if (bar % 2 && !sparse) bassNote(chord.root + 7, start + BEAT * 3.5 + 0.025, BEAT * 0.34, 0.54);

      kick(start + 0.005, sparse ? 0.65 : 0.88);
      kick(start + BEAT * 2.5 + 0.008, sparse ? 0.42 : 0.65);
      if (!interlude) {
        snare(start + BEAT + 0.024, sparse ? 0.55 : 0.85);
        snare(start + BEAT * 3 + 0.030, sparse ? 0.48 : 0.77);
      }
      for (let tick = 0; tick < 8; tick++) {
        const swing = tick % 2 ? 0.029 : 0;
        percussionNoise(start + tick * BEAT * 0.5 + swing + 0.004 + rng() * 0.007,
          tick === 7 && bar % 4 === 3 ? 0.11 : 0.045,
          (tick % 2 ? 0.011 : 0.017) * (sparse ? 0.7 : 1), 6500, 0.26);
      }
      if (!sparse && bar % 2 === 0) {
        const phrase = [[0.75, 0.48], [1.5, 0.68], [2.5, 0.43], [3.25, 1.08]];
        phrase.forEach(([beat, length], note) => {
          leadNote(chord.tune[note], start + beat * BEAT + 0.017, length * BEAT, note === 3 ? 0.72 : 0.84);
        });
      } else if (!sparse && bar % 4 === 3) {
        leadNote(chord.tune[3] - 12, start + BEAT * 2.25, BEAT * 1.25, 0.50);
      }
    }

    const rendered = await offline.startRendering();
    const buffer = new AudioBuffer({ numberOfChannels: 2, length: Math.round(DURATION * SAMPLE_RATE), sampleRate: SAMPLE_RATE });
    const startFrame = Math.round(preroll * SAMPLE_RATE);
    let peak = 0;
    let squareSum = 0;
    for (let channel = 0; channel < 2; channel++) {
      const samples = rendered.getChannelData(channel).subarray(startFrame, startFrame + buffer.length);
      buffer.copyToChannel(samples, channel);
      for (let index = 0; index < samples.length; index++) {
        peak = Math.max(peak, Math.abs(samples[index]));
        squareSum += samples[index] * samples[index];
      }
    }
    const rms = Math.sqrt(squareSum / (buffer.length * 2));
    if (!Number.isFinite(peak) || peak < 0.0001 || !Number.isFinite(rms)) throw new Error('背景音乐合成结果无效');
    const normalization = Math.min(0.78 / peak, 0.12 / rms);
    for (let channel = 0; channel < 2; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let index = 0; index < samples.length; index++) samples[index] *= normalization;
    }
    return { buffer, peak: peak * normalization, rms: rms * normalization };
  }

  window.renderTokyoAfterimage = renderComposition;
})();
