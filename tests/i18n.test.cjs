'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const catalogs = require('../src/locales.js');
const { languages, normalizeLanguage, createI18n } = require('../src/i18n.js');
const codes = ['zh-CN', 'ja', 'en', 'ko', 'es', 'de', 'fr'];
const tokens = text => [...new Set(text.match(/\{[A-Za-z][A-Za-z0-9_]*\}/g) || [])].sort();

test('all seven native language choices are available, with safe Chinese defaults', () => {
  assert.deepEqual(Object.keys(languages), codes);
  assert.deepEqual(Object.values(languages), ['简体中文', '日本語', 'English', '한국어', 'Español', 'Deutsch', 'Français']);
  for (const code of codes) assert.equal(normalizeLanguage(code), code);
  for (const unsupported of [undefined, null, '', 'it', 'en-US', 'EN', 'constructor', '__proto__', 3]) assert.equal(normalizeLanguage(unsupported), 'zh-CN');
});

test('every translated catalog covers the same nonempty strings and preserves parameters', () => {
  const sources = Object.keys(catalogs.en).sort();
  assert.ok(sources.length > 100, 'the complete application catalog must be bundled');
  for (const locale of codes.filter(code => code !== 'zh-CN')) {
    assert.deepEqual(Object.keys(catalogs[locale]).sort(), sources, `${locale} catalog completeness`);
    for (const source of sources) {
      const translated = catalogs[locale][source];
      assert.equal(typeof translated, 'string', `${locale}: ${source}`);
      assert.ok(translated.trim(), `${locale}: ${source} must not be blank`);
      assert.deepEqual(tokens(translated), tokens(source), `${locale}: ${source} parameters`);
    }
  }
});

test('all declared static text, placeholders, accessible names and starter prompts have translations', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const decode = value => value.replace(/&#(?:x([a-f0-9]+)|([0-9]+));/gi, (_match, hex, decimal) => String.fromCodePoint(parseInt(hex || decimal, hex ? 16 : 10))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const sources = [...html.matchAll(/\bdata-i18n(?:-(?:title|aria-label|placeholder|alt|prompt))?="([^"]*)"/g)].map(match => decode(match[1]));
  assert.ok(sources.length > 80, 'static application chrome must explicitly opt into translation');
  for (const source of sources) assert.equal(Object.hasOwn(catalogs.en, source), true, `Missing catalog entry: ${source}`);
});

test('renderer and backend translation calls are covered by every catalog', () => {
  for (const file of ['renderer/app.js', 'app-controller.cjs', 'account-manager.cjs', 'grok-adapter.cjs', 'media.cjs', 'main.cjs']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
    for (const match of source.matchAll(/\bt\(('(?:\\.|[^'\\])*')/g)) {
      const key = vm.runInNewContext(match[1]);
      assert.equal(Object.hasOwn(catalogs.en, key), true, `${file}: missing ${key}`);
    }
  }
});

test('translations follow the current language, interpolate values and leave unknown content untouched', () => {
  let locale = 'en';
  const t = createI18n(() => locale);
  assert.equal(t('偏好设置'), 'Preferences');
  locale = 'ja'; assert.equal(t('偏好设置'), catalogs.ja['偏好设置']);
  locale = 'zh-CN'; assert.equal(t('偏好设置'), '偏好设置');
  locale = 'unsupported'; assert.equal(t('偏好设置'), '偏好设置');
  assert.equal(t('Unknown {name} / {count} / {missing}', { name: '<b>Tokyo</b>', count: 0 }), 'Unknown <b>Tokyo</b> / 0 / {missing}');
  assert.equal(t('Unknown {flag}', { flag: false }), 'Unknown false');
  assert.equal(t('constructor'), 'constructor');
  assert.equal(t('__proto__'), '__proto__');
  assert.equal(t('任意用户文本 / arbitrary user content'), '任意用户文本 / arbitrary user content');
  for (const language of codes) {
    const localize = createI18n(() => language);
    for (const source of Object.keys(catalogs.en).filter(source => tokens(source).length)) {
      const parameters = Object.fromEntries(tokens(source).map(token => [token.slice(1, -1), `value-${token.slice(1, -1)}`]));
      assert.deepEqual(tokens(localize(source, parameters)), [], `${language}: interpolate ${source}`);
    }
  }
});

test('the same offline catalogs and localizer load as browser scripts without CommonJS', () => {
  const context = vm.createContext({});
  for (const file of ['locales.js', 'i18n.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'), context, { filename: file });
  assert.equal(context.TokyoI18n.getLanguage(), 'zh-CN');
  for (const locale of codes) {
    context.TokyoI18n.setLanguage(locale);
    assert.equal(context.TokyoI18n.getLanguage(), locale);
    assert.equal(context.TokyoI18n.t('偏好设置'), createI18n(locale)('偏好设置'));
  }
});
