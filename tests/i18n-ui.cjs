'use strict';

// Real Electron/IPC/rendering with an isolated fake engine: no paid prompts,
// login credentials, personal settings or production conversations are used.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { languages, createI18n } = require('../src/i18n.js');
const root = path.resolve(__dirname, '..');
const base = path.join(root, 'work', 'i18n-qa');
fs.mkdirSync(base, { recursive: true });
const testRoot = fs.mkdtempSync(path.join(base, 'run-'));
const workspace = path.join(testRoot, 'Workspace');
const executable = path.join(testRoot, 'grok.exe');
fs.mkdirSync(workspace); fs.mkdirSync(path.join(testRoot, 'data'));
fs.writeFileSync(executable, 'Fixture only; never executed.');
// Omit language to exercise migration of existing settings.
fs.writeFileSync(path.join(testRoot, 'data', 'conversations.json'), JSON.stringify({ version: 1, settings: { executable, workspace, musicEnabled: false }, sessions: [] }));
const readState = () => JSON.parse(fs.readFileSync(path.join(testRoot, 'data', 'conversations.json'), 'utf8'));
const codes = ['zh-CN', 'ja', 'en', 'ko', 'es', 'de', 'fr'];
const translated = (locale, source, params) => createI18n(() => locale)(source, params);

(async () => {
  const env = { ...process.env, TOKYO_TEST_ROOT: testRoot };
  if (process.argv.includes('--packaged')) env.TOKYO_UI_SOURCE_ROOT = path.join(root, 'App', 'resources', 'app.asar');
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop, page;
  const errors = [], results = [];
  const launch = async () => {
    desktop = await _electron.launch({ args: [path.join(__dirname, 'fixtures', 'ui-app.cjs')], env });
    page = await desktop.firstWindow();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]; win.webContents.setAudioMuted(true); win.setSize(980, 680);
    });
  };
  const ready = locale => page.waitForFunction(label => document.querySelector('#connection-label')?.textContent === label && !document.querySelector('#settings-button').disabled, translated(locale, '引擎已连接'));
  const idle = () => page.waitForFunction(() => document.querySelector('#stop-button').hidden && !document.querySelector('#settings-button').disabled);
  const starts = () => desktop.evaluate(() => globalThis.__tokyoUITest.calls.filter(item => item.method === 'start').length);
  const openSettings = async () => { await page.locator('#settings-button').click(); await page.locator('#settings-dialog').waitFor({ state: 'visible' }); };
  const choose = async locale => {
    await page.locator('#language-select').selectOption(locale);
    await page.waitForFunction(locale => document.documentElement.lang === locale, locale);
  };
  const save = async locale => { await page.locator('#save-settings-button').click(); await page.locator('#settings-dialog').waitFor({ state: 'hidden' }); await ready(locale); };
  const closeSettings = async () => { await page.locator('[data-close-dialog="settings-dialog"]').click(); await page.locator('#settings-dialog').waitFor({ state: 'hidden' }); };
  const stage = async (name, action) => { await action(); results.push(name); console.log(`PASS ${name}`); };
  const assertText = async (selector, source, locale) => assert.equal((await page.locator(selector).textContent()).trim(), translated(locale, source), `${locale}: ${selector}`);
  const assertAttribute = async (selector, attribute, source, locale) => assert.equal(await page.locator(selector).getAttribute(attribute), translated(locale, source), `${locale}: ${selector} ${attribute}`);
  const assertFits = async (selector, allowVerticalScroll = false) => {
    const dimensions = await page.locator(selector).evaluate((element, allowVerticalScroll) => {
      const rect = element.getBoundingClientRect();
      return { visible: rect.width > 0 && rect.height > 0, inside: rect.left >= 0 && rect.right <= innerWidth + 1 && (allowVerticalScroll || (rect.top >= 0 && rect.bottom <= innerHeight + 1)), overflow: element.scrollWidth > element.clientWidth + 1 };
    }, allowVerticalScroll);
    assert.equal(dimensions.visible && dimensions.inside && !dimensions.overflow, true, `${selector} must fit at 980 × 680: ${JSON.stringify(dimensions)}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  };
  try {
    await launch(); await ready('en');
    await stage('settings without a saved language default to English with all seven native language names', async () => {
      assert.equal(await page.locator('html').getAttribute('lang'), 'en');
      await openSettings();
      assert.deepEqual(await page.locator('#language-select option').evaluateAll(items => items.map(item => item.value)), codes);
      for (const locale of codes) assert.equal(await page.locator(`#language-select option[value="${locale}"]`).textContent(), languages[locale]);
      await closeSettings();
    });

    const userText = '偏好设置 · 复制 · 新对话\n日本語 한국어 Français — keep this user content unchanged.';
    const draft = '未发送：偏好设置 / 正在生成 / Entwurf / brouillon';
    await page.locator('#prompt').fill(userText); await page.locator('#send-button').click(); await idle();
    await page.locator('#prompt').fill(draft);
    await page.locator('.thought-details summary').first().click();
    const originalMessages = JSON.stringify(readState().sessions[0].messages);
    const originalTitle = readState().sessions[0].title;
    let savedLocale = 'en';

    for (const locale of codes) {
      await stage(`${locale}: preview, translated controls and dynamic history, save without reconnect`, async () => {
        const before = await starts();
        await openSettings(); await choose(locale);
        assert.equal(readState().settings.language || 'en', savedLocale, 'preview is not persisted');
        await assertText('#settings-dialog h2', '偏好设置', locale);
        await assertText('#connection-label', '引擎已连接', locale);
        await assertText('.titlebar-center', 'A PLACE FOR YOUR NEXT IDEA', locale);
        await assertText('.brand-name span', 'TOKYO EDITION', locale);
        await assertText('#mode-select option:checked', '中等推理强度', locale);
        await assertText('.thought-details summary', '思考过程', locale);
        await assertText('.tool-status', '已完成', locale);
        await assertText('.copy-code', '复制', locale);
        await assertAttribute('#prompt', 'placeholder', '在雨声中，开始你的下一个想法…', locale);
        await assertAttribute('#session-search', 'placeholder', '搜索对话…', locale);
        await assertAttribute('#model-select', 'aria-label', '模型', locale);
        await assertAttribute('#send-button', 'aria-label', '发送消息', locale);
        await assertAttribute('[data-window="close"]', 'aria-label', '关闭窗口', locale);
        await assertAttribute('.copy-code', 'aria-label', '复制代码', locale);
        assert.equal(await page.locator('#prompt').inputValue(), draft);
        assert.equal(await page.locator('.message.user .message-body').textContent(), userText);
        assert.equal(await page.locator('.thought-content').textContent(), 'Fixture reasoning');
        assert.equal(await page.locator('.tool-title').textContent(), 'Fixture tool');
        assert.equal(await page.locator('pre code').textContent(), 'console.log("Tokyo");\n');
        assert.equal(await page.locator('.thought-details').getAttribute('open'), '');
        assert.equal(await page.locator('#model-select').inputValue(), 'grok-4.6');
        assert.equal(await page.locator('#mode-select').inputValue(), 'medium');
        await assertFits('#settings-dialog'); await assertFits('#save-settings-button');
        await page.screenshot({ path: path.join(testRoot, `settings-${locale}.png`), animations: 'disabled' });
        await save(locale); savedLocale = locale;
        assert.equal(readState().settings.language, locale);
        assert.equal(await starts(), before, 'language-only save must not reconnect');
        assert.equal(JSON.stringify(readState().sessions[0].messages), originalMessages);
        assert.equal(readState().sessions[0].title, originalTitle);
        assert.equal(await page.locator('#prompt').inputValue(), draft);

        await page.locator('#search-toggle').click(); await page.locator('#session-search').fill('no-matching-language-test-chat');
        await assertText('.history-empty', '没有找到这段对话。', locale);
        await page.locator('#session-search').press('Escape');
        await page.locator('#account-button').click();
        await assertText('#accounts-title', '账户管理', locale);
        await assertAttribute('#account-name-input', 'placeholder', '账户名称，例如：工作账户', locale);
        await assertText('[data-account-action="switch"]', '当前账户 ✓', locale);
        await assertFits('#accounts-dialog');
        await page.locator('[data-close-dialog="accounts-dialog"]').click();
        await openSettings(); await page.locator('#choose-workspace').click();
        const chooser = await desktop.evaluate(() => globalThis.__tokyoUITest.calls.filter(item => item.method === 'showOpenDialog').at(-1));
        assert.equal(chooser.options.title, translated(locale, '选择 Grok 工作目录'));
        await closeSettings();
      });
    }

    await stage('close and Escape restore the saved language while preserving all drafts', async () => {
      for (const dismiss of ['close', 'Escape']) {
        await openSettings(); await choose('ja');
        await page.locator('#workspace-input').fill('unsaved settings draft');
        await choose('ko');
        assert.equal(await page.locator('#workspace-input').inputValue(), 'unsaved settings draft');
        if (dismiss === 'close') await closeSettings(); else { await page.keyboard.press('Escape'); await page.locator('#settings-dialog').waitFor({ state: 'hidden' }); }
        await page.waitForFunction(() => document.documentElement.lang === 'fr');
        await assertText('#connection-label', '引擎已连接', 'fr');
        assert.equal(readState().settings.language, 'fr');
        assert.equal(await page.locator('#prompt').inputValue(), draft);
        await openSettings(); assert.equal(await page.locator('#workspace-input').inputValue(), workspace); await closeSettings();
      }
    });

    await stage('validation and native dialogs follow unsaved language previews', async () => {
      await openSettings(); await choose('en');
      await page.locator('#executable-input').fill(''); await page.locator('#save-settings-button').click();
      await assertText('#settings-feedback', '请选择 Grokbuild 的 grok.exe 文件。', 'en');
      await choose('ja'); await assertText('#settings-feedback', '请选择 Grokbuild 的 grok.exe 文件。', 'ja');
      await page.locator('#executable-input').fill(executable);
      await page.locator('#workspace-input').fill(path.join(testRoot, 'missing-workspace'));
      await page.locator('#save-settings-button').click();
      await page.waitForFunction(label => document.querySelector('#settings-feedback').textContent === label, translated('ja', '请选择有效的工作目录'));
      await choose('de'); await assertText('#settings-feedback', '请选择有效的工作目录', 'de');
      for (const [selector, title] of [['#choose-workspace', '选择 Grok 工作目录'], ['#choose-executable', '选择 grok.exe']]) {
        await page.locator(selector).click();
        const chooser = await desktop.evaluate(() => globalThis.__tokyoUITest.calls.filter(item => item.method === 'showOpenDialog').at(-1));
        assert.equal(chooser.options.title, translated('de', title));
        if (selector === '#choose-executable') assert.equal(chooser.options.filters[0].name, translated('de', 'Grok 可执行文件'));
      }
      assert.equal(readState().settings.language, 'fr');
      assert.equal(readState().settings.workspace, workspace);
      await closeSettings();
      await page.locator('#account-button').click();
      await page.locator('#account-name-input').fill(''); await page.locator('#add-account-button').click();
      assert.equal(await page.locator('#account-name-input').evaluate(input => input.validationMessage), translated('fr', '请输入账户名称。'));
      await page.locator('[data-close-dialog="accounts-dialog"]').click();
      const openRename = async () => {
        await page.locator('.session-item.active').hover(); await page.locator('.session-item.active .session-more').click(); await page.locator('#menu-rename').click();
      };
      await openRename(); await page.locator('#rename-input').fill(''); await page.locator('#rename-form button[type="submit"]').click();
      assert.equal(await page.locator('#rename-input').evaluate(input => input.validationMessage), translated('fr', '请输入对话标题。'));
      await page.locator('#rename-dialog [data-close-dialog]').first().click(); await openRename();
      assert.equal(await page.locator('#rename-input').evaluate(input => input.checkValidity()), true, 'reopening a valid title clears prior validation errors');
      await page.locator('#rename-dialog [data-close-dialog]').first().click();
      assert.equal(await page.locator('#prompt').inputValue(), draft);
    });

    await stage('starter prompts translate for all languages and long welcome copy fits', async () => {
      await page.locator('#new-session').click();
      const source = '请先查看当前工作目录，帮我理解这个项目的结构、技术栈和运行方式。';
      for (const locale of codes) {
        await openSettings(); await choose(locale); await save(locale);
        const card = page.locator('[data-prompt]').first();
        assert.equal(await card.getAttribute('data-prompt'), translated(locale, source));
        await card.click(); assert.equal(await page.locator('#prompt').inputValue(), translated(locale, source));
        await assertFits('#welcome', true);
        if (['de', 'fr'].includes(locale)) {
          await page.waitForFunction(() => document.querySelector('#toast-container').childElementCount === 0);
          await page.screenshot({ path: path.join(testRoot, `welcome-${locale}.png`), animations: 'disabled' });
        }
      }
      await page.locator('.session-select').first().click(); await idle();
      assert.equal(await page.locator('#prompt').inputValue(), draft);
    });

    await stage('language changes during generation preserve the stream and translated permission choices', async () => {
      await page.locator('#prompt').fill('PERMISSION language preview'); await page.locator('#send-button').click();
      await page.locator('#permission-panel').waitFor({ state: 'visible' });
      const before = await starts();
      for (const locale of ['en', 'ko', 'de']) {
        await openSettings(); await choose(locale); await save(locale);
        assert.equal(await page.locator('#stop-button').isVisible(), true);
        await assertAttribute('#stop-button', 'aria-label', '停止生成', locale);
        await assertText('#permission-panel button:first-child', '允许一次', locale);
        assert.equal(await starts(), before);
      }
      await page.locator('#permission-panel button:first-child').click(); await idle();
      const choice = await desktop.evaluate(() => globalThis.__tokyoUITest.calls.filter(item => item.method === 'respondPermission').at(-1));
      assert.equal(choice.optionId, 'allow-once');
      await page.locator('#prompt').fill('WAIT language cancellation'); await page.locator('#send-button').click();
      await page.locator('#stop-button').waitFor({ state: 'visible' });
      await openSettings(); await choose('fr'); await save('fr');
      await page.locator('#stop-button').click(); await idle();
      await assertText('.message-cancelled', '本次生成已停止', 'fr');
    });

    await stage('image controls relocalize while authored image descriptions and Markdown stay unchanged', async () => {
      fs.copyFileSync(path.join(root, 'src/renderer/assets/icon.png'), path.join(workspace, 'locale-image.png'));
      fs.copyFileSync(path.join(workspace, 'locale-image.png'), path.join(workspace, 'locale-named.png'));
      await desktop.evaluate(() => {
        const adapter = globalThis.__tokyoUITest.adapter;
        const original = adapter.prompt;
        adapter.prompt = async function(args) {
          const result = await original.call(this, args);
          this.emit('event', { type: 'text', sessionId: args.sessionId, text: '\n\n![](locale-image.png)\n\n![Grok 返回的图片](locale-named.png)\n\n![](locale-missing.png)\n\n<div data-i18n="偏好设置">Authored Markdown</div>' });
          this.prompt = original;
          return result;
        };
      });
      await page.locator('#prompt').fill('Image locale regression'); await page.locator('#send-button').click(); await idle();
      await page.waitForFunction(() => document.querySelectorAll('.chat-image').length === 3);
      for (const image of await page.locator('.chat-image img').all()) {
        await image.evaluate(element => { element.loading = 'eager'; });
      }
      await page.waitForFunction(() => [...document.querySelectorAll('.chat-image img')].filter(image => !image.hidden).every(image => image.complete && image.naturalWidth > 0));
      await page.locator('.image-retry').last().waitFor({ state: 'visible' });
      for (const locale of ['en', 'ja', 'fr']) {
        await openSettings(); await choose(locale); await save(locale);
        assert.equal(await page.locator('.chat-image img').first().getAttribute('alt'), translated(locale, '图片'));
        assert.equal(await page.locator('.chat-image img').nth(1).getAttribute('alt'), 'Grok 返回的图片');
        assert.equal(await page.locator('.chat-image figcaption').last().textContent(), translated(locale, '找不到图片文件，文件可能已移动或删除'));
        assert.equal(await page.locator('#messages [data-i18n]').count(), 0, 'reply HTML cannot create application translation attributes');
        assert.equal(await page.getByText('Authored Markdown', { exact: true }).textContent(), 'Authored Markdown');
        assert.equal(await page.locator('.chat-image figcaption').first().textContent(), translated(locale, '{alt} · 点击放大', { alt: translated(locale, '图片') }));
      }
    });

    await stage('live plans and stop reasons remain visible and relocalize in all seven languages', async () => {
      await page.locator('#prompt').fill('WAIT plan localization'); await page.locator('#send-button').click();
      await page.locator('#stop-button').waitFor({ state: 'visible' });
      const entries = [
        { content: '偏好设置 — authored plan', priority: 'high', status: 'completed' },
        { content: 'Fixture implementation', priority: 'medium', status: 'in_progress' },
        { content: 'Fixture validation', priority: 'low', status: 'pending' },
      ];
      await desktop.evaluate((_electron, entries) => {
        const test = globalThis.__tokyoUITest;
        test.adapter.emit('event', { type: 'status', status: 'plan', sessionId: test.calls.filter(call => call.method === 'prompt').at(-1).sessionId, entries });
      }, entries);
      await page.locator('.plan-details').waitFor({ state: 'visible' });
      await page.locator('.plan-details summary').click();
      const before = await starts();
      for (const locale of codes) {
        await openSettings(); await choose(locale); await save(locale);
        await assertText('.plan-details summary', '执行计划', locale);
        assert.deepEqual(await page.locator('.plan-content').allTextContents(), entries.map(entry => entry.content));
        assert.deepEqual(await page.locator('.plan-status').allTextContents(), ['已完成', '执行中', '等待中'].map(source => translated(locale, source)));
        assert.equal(await page.locator('.plan-details').getAttribute('open'), null);
        assert.equal(await page.locator('#stop-button').isVisible(), true);
      }
      assert.equal(await starts(), before);
      await page.locator('.plan-details summary').click(); await page.locator('.plan-details').scrollIntoViewIfNeeded();
      await assertFits('.plan-details', true);
      await page.screenshot({ path: path.join(testRoot, 'plan-fr.png'), animations: 'disabled' });
      await desktop.evaluate(() => {
        const adapter = globalThis.__tokyoUITest.adapter;
        for (const [id, resolve] of adapter.pending) { resolve({ stopReason: 'max_tokens' }); adapter.pending.delete(id); }
      });
      await idle();
      const notices = [
        ['max_tokens', '回复达到输出长度上限，可发送消息让 Grok 继续。'],
        ['max_turn_requests', '本轮已达到请求次数上限，可发送消息让 Grok 继续。'],
        ['refusal', 'Grok 拒绝了这次请求。'],
      ];
      for (const [reason, source] of notices) {
        if (reason !== 'max_tokens') {
          await desktop.evaluate((_electron, reason) => {
            const adapter = globalThis.__tokyoUITest.adapter; const original = adapter.prompt;
            adapter.prompt = async function() { this.prompt = original; return { stopReason: reason }; };
          }, reason);
          await page.locator('#prompt').fill(`Stop reason ${reason}`); await page.locator('#send-button').click(); await idle();
        }
        await page.waitForFunction(label => [...document.querySelectorAll('.message-notice')].at(-1)?.textContent === label, translated('fr', source));
      }
      await openSettings();
      for (const locale of codes) {
        await choose(locale);
        assert.deepEqual(await page.locator('.message-notice').allTextContents(), notices.map(([, source]) => translated(locale, source)));
      }
      await closeSettings();
      assert.deepEqual(readState().sessions[0].messages.find(message => message.plan?.length)?.plan, entries);
      assert.equal(await page.locator('.message-error').count(), 0);
    });

    await stage('saved French language and original conversation survive a full restart', async () => {
      await desktop.close(); await launch(); await ready('fr');
      assert.equal(await page.locator('html').getAttribute('lang'), 'fr');
      await openSettings(); assert.equal(await page.locator('#language-select').inputValue(), 'fr'); await closeSettings();
      assert.equal(readState().sessions[0].messages[0].text, userText);
      await assertAttribute('#prompt', 'placeholder', '在雨声中，开始你的下一个想法…', 'fr');
      assert.deepEqual(errors, []);
    });
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(testRoot, 'failure.png'), animations: 'disabled' }).catch(() => {});
    errors.push(error.stack || error.message); throw error;
  } finally {
    if (desktop) await desktop.close().catch(() => {});
    fs.writeFileSync(path.join(testRoot, 'results.json'), JSON.stringify({ isolated: true, packagedResources: process.argv.includes('--packaged'), realGenerations: 0, results, errors }, null, 2));
    console.log(JSON.stringify({ passed: results.length, failed: errors.length, output: testRoot }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
