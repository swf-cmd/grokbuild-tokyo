'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const catalogs = require('../src/locales.js');
const { createI18n } = require('../src/i18n.js');
const { themes, ids, defaultTheme, normalizeTheme, textFields, previewSprite } = require('../src/themes.js');
const { build, palettes, transformHex } = require('../scripts/build-theme-css.cjs');
const { packageFiles } = require('../scripts/package-policy.cjs');

const root = path.resolve(__dirname, '..');
const renderer = path.join(root, 'src', 'renderer');
const assets = path.join(renderer, 'assets');
const codes = ['ja', 'en', 'ko', 'es', 'de', 'fr'];

function playerTracks() {
  const window = { addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(renderer, 'ambient-audio.js'), 'utf8'), { window, document: { baseURI: 'file:///app/index.html' }, URL });
  return window.TokyoAmbience.tracks;
}

// Width and height of a lossy, lossless or extended WebP file.
function webpSize(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') { const bits = bytes.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
  if (chunk === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  throw new Error(`Unknown WebP chunk ${chunk}`);
}

// STREAMINFO of a FLAC file: sample rate, channels, bit depth and length.
function flacInfo(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'fLaC');
  assert.equal(bytes[4] & 0x7f, 0, 'STREAMINFO comes first');
  const info = bytes.subarray(8, 8 + 34);
  const sampleRate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
  const channels = ((info[12] >> 1) & 0x7) + 1;
  const bitsPerSample = (((info[12] & 1) << 4) | (info[13] >> 4)) + 1;
  const samples = (info[13] & 0x0f) * 2 ** 32 + info.readUInt32BE(14);
  return { sampleRate, channels, bitsPerSample, samples };
}

test('four city themes share one shape, with Tokyo as the safe default', () => {
  assert.deepEqual(ids, ['tokyo', 'kyoto', 'okinawa', 'hokkaido']);
  assert.equal(defaultTheme, 'tokyo');
  for (const id of ids) assert.equal(normalizeTheme(id), id);
  for (const unknown of [undefined, null, '', 'Kyoto', 'osaka', 'toString', '__proto__', 3, {}]) assert.equal(normalizeTheme(unknown), 'tokyo');
  const fields = Object.keys(themes.tokyo).sort();
  for (const id of ids) {
    const theme = themes[id];
    assert.equal(theme.id, id);
    assert.deepEqual(Object.keys(theme).sort(), fields, `${id} fields`);
    assert.ok(Object.isFrozen(theme));
    assert.match(theme.hero, /^[A-Z]+$/);
    assert.match(theme.coordinates, /^\d+°\d{2}′ N \/ \d+°\d{2}′ E$/);
    assert.match(theme.windowBackground, /^#[0-9a-f]{6}$/);
    assert.equal([...theme.glyph].length, 1);
  }
  for (const field of ['hero', 'glyph', 'edition', 'subtitle', 'volume', 'tagline', 'headline', 'location', 'coordinates', 'placeholder', 'station', 'backdrop', 'windowBackground']) {
    assert.equal(new Set(ids.map(id => themes[id][field])).size, ids.length, `every city has its own ${field}`);
  }
});

test('the original Tokyo copy is unchanged and is what the static page shows', () => {
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const tokyo = themes.tokyo;
  assert.match(html, /<span id="hero-city">TOKYO<\/span>/);
  for (const field of ['edition', 'subtitle', 'volume', 'tagline', 'location']) assert.ok(html.includes(`data-i18n="${tokyo[field]}"`), field);
  assert.ok(html.includes(tokyo.coordinates));
  assert.ok(html.includes(`class="hero-star" id="hero-star">${tokyo.glyph}<`));
});

test('every city text is translated in every catalog without parameters', () => {
  for (const id of ids) {
    for (const field of textFields) {
      const key = themes[id][field];
      for (const code of codes) {
        assert.equal(typeof catalogs[code][key], 'string', `${code}: ${id}.${field}`);
        assert.ok(catalogs[code][key].trim(), `${code}: ${id}.${field}`);
        assert.doesNotMatch(catalogs[code][key], /\{[A-Za-z]/, `${code}: ${id}.${field}`);
      }
      if (/^[\x00-\x7F]+$/.test(key)) assert.match(catalogs['zh-CN'][key], /[一-鿿]/, `zh-CN: ${id}.${field}`);
    }
  }
  for (const key of ['正在播放 · {station} · 离线循环', '正在准备{station}…', '点击窗口或按任意键，开启{station}。']) {
    for (const code of codes) assert.match(catalogs[code][key], /\{station\}/, `${code}: ${key}`);
  }
});

test('Tokyo music status reads exactly as it did before the city templates', () => {
  // The messages Tokyo showed when the station name was written into each one.
  const before = {
    'zh-CN': ['正在播放 · 东京午夜电台 · 离线循环', '正在准备东京午夜电台…', '点击窗口或按任意键，开启东京午夜电台。'],
    ja: ['再生中 · 東京ミッドナイトラジオ · オフラインループ', '東京ミッドナイトラジオを準備中…', 'ウィンドウをクリックするかキーを押して、東京ミッドナイトラジオを再生。'],
    en: ['Playing · Tokyo Midnight Radio · Offline loop', 'Preparing Tokyo Midnight Radio…', 'Click the window or press any key to start Tokyo Midnight Radio.'],
    ko: ['재생 중 · 도쿄 자정 라디오 · 오프라인 반복', '도쿄 자정 라디오 준비 중…', '창을 클릭하거나 아무 키나 눌러 도쿄 자정 라디오를 켜세요.'],
    es: ['Reproduciendo · Radio de medianoche de Tokio · Bucle sin conexión', 'Preparando Radio de medianoche de Tokio…', 'Haz clic en la ventana o pulsa una tecla para iniciar Radio de medianoche de Tokio.'],
    de: ['Wiedergabe · Tokyo Midnight Radio · Offline-Schleife', 'Tokyo Midnight Radio wird vorbereitet…', 'Klicke ins Fenster oder drücke eine Taste, um Tokyo Midnight Radio zu starten.'],
    fr: ['Lecture · Radio de minuit de Tokyo · Boucle hors ligne', 'Préparation de Radio de minuit de Tokyo…', 'Cliquez dans la fenêtre ou appuyez sur une touche pour lancer Radio de minuit de Tokyo.'],
  };
  for (const [code, expected] of Object.entries(before)) {
    const t = createI18n(() => code);
    const station = t(themes.tokyo.station);
    assert.deepEqual(['正在播放 · {station} · 离线循环', '正在准备{station}…', '点击窗口或按任意键，开启{station}。'].map(key => t(key, { station })), expected, code);
  }
});

test('the picker offers every city in order with its own preview tile', () => {
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const values = [...html.matchAll(/<input type="radio" name="theme" value="([a-z]+)">/g)].map(match => match[1]);
  assert.deepEqual(values, ids);
  const css = fs.readFileSync(path.join(renderer, 'themes.css'), 'utf8');
  for (const id of ids) assert.match(css, new RegExp(`\\.theme-option\\[data-theme-option="${id}"\\] \\{ --swatch: #[0-9a-f]{6}; \\}`));
  const sprite = webpSize(fs.readFileSync(path.join(assets, previewSprite)));
  assert.equal(sprite.height, sprite.width / 16 * 9 * ids.length, 'one 16:9 tile per city');
});

test('each city ships its own backdrop and lossless 96-second soundtrack', () => {
  const tracks = playerTracks();
  assert.deepEqual(Object.keys(tracks), ids, 'the player has one track per city');
  const files = new Set();
  for (const id of ids) {
    const backdrop = path.join(assets, themes[id].backdrop);
    if (id !== 'tokyo') {
      const size = webpSize(fs.readFileSync(backdrop));
      assert.deepEqual(size, { width: 2400, height: 1350 }, `${id} backdrop size`);
      assert.ok(fs.statSync(backdrop).size < 1.5 * 1024 * 1024, `${id} backdrop stays light`);
      const info = flacInfo(fs.readFileSync(path.join(assets, tracks[id].file)));
      assert.deepEqual(info, { sampleRate: 44100, channels: 2, bitsPerSample: 16, samples: tracks[id].duration * 44100 }, `${id} soundtrack`);
    }
    assert.equal(tracks[id].duration, 96);
    for (const file of [themes[id].backdrop, tracks[id].file]) {
      assert.ok(packageFiles.includes(`src/renderer/assets/${file}`), `${file} is packaged`);
      files.add(file);
    }
  }
  assert.equal(files.size, ids.length * 2, 'no two cities share an asset');
});

test('generated theme colors match styles.css and every referenced asset exists', () => {
  const generated = fs.readFileSync(path.join(renderer, 'theme-colors.css'), 'utf8');
  assert.equal(generated, build(), 'run node scripts/build-theme-css.cjs after changing styles.css');
  for (const id of ids.filter(id => id !== 'tokyo')) assert.ok(generated.includes(`:root[data-theme="${id}"]{--bg:`), `${id} palette`);
  assert.equal(generated.includes('data-theme="tokyo"'), false, 'Tokyo keeps styles.css as written');
  for (const file of ['styles.css', 'theme-colors.css', 'themes.css']) {
    const css = fs.readFileSync(path.join(renderer, file), 'utf8');
    for (const [, reference] of css.matchAll(/url\("(assets\/[^"]+)"\)/g)) {
      assert.ok(fs.existsSync(path.join(renderer, reference)), `${file}: ${reference}`);
      assert.ok(packageFiles.includes(`src/renderer/${reference}`), `${reference} is packaged`);
    }
  }
  for (const file of ['src/themes.js', 'src/renderer/theme-colors.css', 'src/renderer/themes.css']) assert.ok(packageFiles.includes(file), file);
});

// WCAG 2 contrast ratio of two #rrggbb colors.
function contrast(a, b) {
  const luminance = hex => {
    const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

test('the daylight cities keep text, links and buttons readable', () => {
  // Tokyo's own pairs, as written in styles.css, mapped into each city.
  const tokyo = { background: '#0b1014', text: '#e8eae5', muted: '#838d90', accent: '#d4eb89', onAccent: '#242d24', error: '#dc927c' };
  for (const id of ids.filter(id => id !== 'tokyo')) {
    const palette = palettes[id];
    assert.equal(palette.scheme, 'light', `${id} is a daylight edition`);
    const color = (hex, property) => transformHex(hex, palette, property).slice(0, 7);
    const background = color(tokyo.background);
    assert.ok(contrast(background, '#000000') > contrast(background, '#ffffff'), `${id}: light background`);
    for (const [name, foreground, minimum] of [['text', color(tokyo.text), 7], ['muted text', color(tokyo.muted), 4.5], ['links', color(tokyo.accent), 4.5], ['errors', color(tokyo.error), 4.5]]) {
      assert.ok(contrast(foreground, background) >= minimum, `${id}: ${name} ${foreground} on ${background} is ${contrast(foreground, background).toFixed(2)}`);
    }
    const button = contrast(color(tokyo.onAccent, 'color'), color(tokyo.accent));
    assert.ok(button >= 4.5, `${id}: button label contrast ${button.toFixed(2)}`);
    // Shadows stay dark in daylight instead of mirroring into glows.
    assert.ok(contrast(color('#000000', 'box-shadow'), '#ffffff') > 7, `${id}: shadows stay dark`);
  }
});

test('every sidebar background ends in an opaque color, so its text keeps subpixel antialiasing', () => {
  // The animated weather layer makes Chromium composite the sidebar, which is
  // painted after it. A composited layer keeps ClearType text only when it is
  // known to be opaque, and a gradient alone does not tell Chromium that.
  const declarations = [];
  for (const file of ['styles.css', 'theme-colors.css', 'themes.css']) {
    const css = fs.readFileSync(path.join(renderer, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!selector.split(',').some(part => /\.sidebar$/.test(part.trim()))) continue;
      for (const [, value] of body.matchAll(/(?:^|;)\s*background\s*:([^;]+)/g)) declarations.push({ file, selector: selector.trim(), value: value.trim() });
    }
  }
  assert.ok(declarations.length >= 7, `found ${declarations.length} sidebar backgrounds`);
  for (const { file, selector, value } of declarations) {
    assert.match(value, /\s#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, `${file} ${selector} needs an opaque color at the end of its background: ${value}`);
  }
});
