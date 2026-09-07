/* Shared, dependency-free localization for Electron and its isolated renderer. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./locales.js'));
  else root.TokyoI18n = factory(root.TokyoLocales);
})(typeof globalThis === 'object' ? globalThis : this, function(catalogs) {
  'use strict';
  const languages = Object.freeze({ 'zh-CN': '简体中文', ja: '日本語', en: 'English', ko: '한국어', es: 'Español', de: 'Deutsch', fr: 'Français' });
  const normalizeLanguage = value => typeof value === 'string' && Object.hasOwn(languages, value) ? value : 'zh-CN';
  let language = 'zh-CN';
  const createI18n = getLocale => (source, params = {}) => {
    const locale = normalizeLanguage(typeof getLocale === 'function' ? getLocale() : getLocale);
    const catalog = catalogs?.[locale];
    const translated = catalog && Object.hasOwn(catalog, source) ? catalog[source] : source;
    return String(translated).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, key) => Object.hasOwn(params, key) ? String(params[key]) : token);
  };
  const t = createI18n(() => language);
  const setLanguage = value => (language = normalizeLanguage(value));
  const getLanguage = () => language;
  // Application diagnostics can be saved with a conversation or arrive from
  // the main process in the saved language while the renderer previews another.
  // Recognize only complete catalog messages, never scan authored chat content.
  const diagnosticKeys = new Map();
  const diagnosticPatterns = [];
  const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const source of Object.keys(catalogs.en || {})) {
    for (const template of new Set([source, ...Object.values(catalogs).map(catalog => catalog[source]).filter(Boolean)])) {
      const parameters = [...template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)];
      if (!parameters.length) { diagnosticKeys.set(template, source); continue; }
      let pattern = '', position = 0;
      for (const parameter of parameters) {
        pattern += escapePattern(template.slice(position, parameter.index)) + '([\\s\\S]*?)';
        position = parameter.index + parameter[0].length;
      }
      pattern += escapePattern(template.slice(position));
      diagnosticPatterns.push({ source, parameters: parameters.map(parameter => parameter[1]), pattern: new RegExp(`^${pattern}$`) });
    }
  }
  function localizeDiagnostic(value) {
    const message = String(value ?? '').replace(/^Error invoking remote method 'tokyo:[^']+': (?:Error: )?/, '');
    if (diagnosticKeys.has(message)) return t(diagnosticKeys.get(message));
    for (const { source, parameters, pattern } of diagnosticPatterns) {
      const match = pattern.exec(message);
      if (!match) continue;
      const values = {};
      let consistent = true;
      parameters.forEach((parameter, index) => {
        if (Object.hasOwn(values, parameter) && values[parameter] !== match[index + 1]) consistent = false;
        values[parameter] = match[index + 1];
      });
      if (consistent) return t(source, values);
    }
    return message;
  }
  function apply(document) {
    document.documentElement.lang = language;
    // Only explicitly marked application chrome is translated. Chat HTML and
    // user-created names are never scanned or rewritten.
    for (const element of document.querySelectorAll('[data-i18n]')) {
      if (!element.closest('#messages')) element.textContent = t(element.getAttribute('data-i18n'));
    }
    for (const attribute of ['title', 'aria-label', 'placeholder', 'alt', 'prompt']) {
      for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
        if (element.closest('#messages')) continue;
        element.setAttribute(attribute === 'prompt' ? 'data-prompt' : attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
      }
    }
  }
  return Object.freeze({ languages, normalizeLanguage, createI18n, t, setLanguage, getLanguage, localizeDiagnostic, apply });
});
