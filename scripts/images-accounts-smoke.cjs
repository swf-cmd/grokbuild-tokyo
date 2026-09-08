'use strict';
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const base = path.join(root, 'work', 'images-accounts-qa');
fs.mkdirSync(base, { recursive: true });
const testRoot = fs.mkdtempSync(path.join(base, 'run-'));
const workspace = path.join(testRoot, 'Workspace');
const executable = path.join(testRoot, process.platform === 'win32' ? 'grok.exe' : 'grok');
fs.mkdirSync(workspace); fs.mkdirSync(path.join(testRoot, 'data')); fs.writeFileSync(executable, 'Fixture only');
fs.chmodSync(executable, 0o755);
const png = fs.readFileSync(path.join(root, 'src/renderer/assets/tokyo-rain.png'));
const icon = fs.readFileSync(path.join(root, 'src/renderer/assets/icon.png'));
fs.writeFileSync(path.join(workspace, '东京 image.png'), png);
fs.writeFileSync(path.join(workspace, 'absolute.png'), icon);
fs.writeFileSync(path.join(testRoot, 'data/conversations.json'), JSON.stringify({ version: 1, settings: { executable, workspace, musicEnabled: false, language: 'zh-CN' }, sessions: [] }));
const readState = () => JSON.parse(fs.readFileSync(path.join(testRoot, 'data/conversations.json'), 'utf8'));

(async () => {
  const env = { ...process.env, TOKYO_TEST_ROOT: testRoot };
  if (process.argv.includes('--packaged')) env.TOKYO_UI_SOURCE_ROOT = require('../scripts/package-paths.cjs').packagedArchive(root);
  delete env.ELECTRON_RUN_AS_NODE;
  const launchArgs = [path.join(root, 'tests/fixtures/ui-app.cjs')];
  const scale = process.argv.find(arg => arg.startsWith('--scale='))?.slice('--scale='.length);
  if (scale) {
    assert.ok(['1', '1.5', '2'].includes(scale), 'Use --scale=1, --scale=1.5 or --scale=2');
    launchArgs.unshift(`--force-device-scale-factor=${scale}`);
  }
  let desktop = await _electron.launch({ args: launchArgs, env });
  let page = await desktop.firstWindow();
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setAudioMuted(true));
  if (process.argv.includes('--compact')) await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
  page.setDefaultTimeout(10000);
  const errors = [], results = [], requestFailures = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('requestfailed', request => requestFailures.push({ url: request.url().slice(0, 240), error: request.failure()?.errorText }));
  await page.route('https://images.example.test/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: icon }));
  const ready = () => page.waitForFunction(() => document.querySelector('#connection-label').textContent.includes('已连接') && !document.querySelector('#account-button').disabled);
  const idle = () => page.waitForFunction(() => document.querySelector('#stop-button').hidden && !document.querySelector('#account-button').disabled);
  const stage = async (name, action) => { await action(); results.push(name); console.log(`PASS ${name}`); };
  const closeAccounts = () => page.locator('[data-close-dialog="accounts-dialog"]').click();
  const accountRow = id => page.locator(`.account-row[data-account-id="${id}"]`);
  const switchRow = id => accountRow(id).locator('[data-account-action="switch"]');
  const renameRow = id => accountRow(id).locator('[data-account-action="rename"]');
  const deleteRow = id => accountRow(id).locator('[data-account-action="delete"]');
  const verifyImages = async (repaired = false) => {
    const successful = ['东京雨夜', '本地图标', '网络图片', 'HTML 图片', 'ACP 内嵌图片', ...(repaired ? ['失效图片'] : [])];
    const failed = repaired ? ['危险链接'] : ['失效图片', '危险链接'];
    await page.waitForFunction(() => document.querySelectorAll('.chat-image').length === 7);
    for (const alt of successful) {
      const figure = page.locator('.chat-image').filter({ has: page.getByAltText(alt, { exact: true }) });
      // Resolve each source before scrolling: Chromium loads offscreen lazy images
      // according to its viewport/network heuristics, not their order in the DOM.
      await page.waitForFunction(name => {
        const img = [...document.querySelectorAll('.image-thumbnail img')].find(item => item.alt === name);
        return img && (img.getAttribute('src') || img.hidden);
      }, alt);
      assert.equal(await figure.locator('img').evaluate(img => img.hidden), false, `${alt}: ${await figure.locator('figcaption').textContent()}`);
      await figure.scrollIntoViewIfNeeded();
      await page.waitForFunction(name => {
        const img = [...document.querySelectorAll('.image-thumbnail img')].find(item => item.alt === name);
        return img?.complete && img.naturalWidth > 0;
      }, alt);
      assert.equal(await figure.locator('.image-thumbnail').isEnabled(), true, `${alt} must open in the preview`);
      assert.equal(await figure.locator('.image-retry').isHidden(), true);
    }
    for (const alt of failed) {
      const figure = page.locator('.chat-image').filter({ has: page.getByAltText(alt, { exact: true }) });
      await figure.locator('.image-retry').waitFor({ state: 'visible' });
      assert.equal(await figure.locator('.image-thumbnail').isDisabled(), true);
    }
    assert.equal(await page.locator('.image-thumbnail img').evaluateAll(images => images.filter(img => img.complete && img.naturalWidth > 0).length), successful.length);
    assert.equal(await page.locator('.image-retry:visible').count(), failed.length);
  };
  try {
    await ready();
    let originalSession, newAccount, localSessionCount;
    await stage('Markdown local, remote, HTML and ACP images display during streaming', async () => {
      await page.locator('#prompt').fill('WAIT image previews'); await page.locator('#send-button').click();
      await page.waitForFunction(() => !document.querySelector('#stop-button').hidden && !document.querySelector('#prompt').disabled);
      originalSession = readState().sessions[0].id;
      await desktop.evaluate((_electron, data) => {
        const adapter = globalThis.__tokyoUITest.adapter;
        adapter.emit('event', { type: 'text', sessionId: data.sessionId, text: `## 雨夜里的图片\n\n![东京雨夜](<东京 image.png>)\n\n[本地图标](<${data.absolute}>)\n\n![网络图片](https://images.example.test/preview.png)\n\n<img src="absolute.png" alt="HTML 图片" onerror="window.__unsafe=1">\n\n![失效图片](missing.png)\n\n![危险链接](javascript:alert)\n\n<script>window.__unsafe=1</script>` });
        adapter.emit('event', { type: 'image', sessionId: data.sessionId, image: { src: `data:image/png;base64,${data.icon}`, alt: 'ACP 内嵌图片' } });
      }, { sessionId: originalSession, absolute: path.join(workspace, 'absolute.png'), icon: icon.toString('base64') });
      await verifyImages();
      assert.equal(await page.evaluate(() => window.__unsafe), undefined);
      const first = page.locator('.image-thumbnail').first(); await first.scrollIntoViewIfNeeded(); await first.click();
      await page.locator('#image-dialog').waitFor({ state: 'visible' });
      await page.waitForFunction(() => { const img = document.querySelector('#image-preview'); return img.complete && img.naturalWidth > 0; });
      await page.screenshot({ path: path.join(testRoot, 'image-preview.png') });
      await page.keyboard.press('Escape'); await page.locator('#image-dialog').waitFor({ state: 'hidden' });
    });
    await stage('busy accounts are locked; image history survives reload and export', async () => {
      await page.locator('#account-button').click();
      assert.equal(await page.locator('#account-login').isDisabled(), true);
      assert.equal(await page.locator('#add-account-button').isDisabled(), true);
      assert.equal(await renameRow('local').isDisabled(), true);
      await closeAccounts(); await page.locator('#stop-button').click(); await idle();
      assert.equal(readState().sessions[0].messages.at(-1).images.length, 1);
      await page.reload(); await ready(); await page.locator('.session-select').first().click();
      await verifyImages();
      fs.writeFileSync(path.join(workspace, 'missing.png'), icon);
      await page.locator('.chat-image').filter({ hasText: '找不到图片文件' }).locator('.image-retry').click();
      await verifyImages(true);
      const exportFile = path.join(testRoot, 'images.md');
      await desktop.evaluate((_e, file) => globalThis.__tokyoUITest.dialogs.push({ canceled: false, filePath: file }), exportFile);
      await page.locator('#export-button').click();
      await page.waitForFunction(() => document.querySelector('#toast-container').textContent.includes('已导出'));
      assert.ok(fs.readFileSync(exportFile, 'utf8').includes('![ACP 内嵌图片](<data:image/png;base64,'));
      await page.locator('.image-thumbnail').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(testRoot, 'conversation-images.png') });
    });
    await stage('add account, device challenge, cancel, failed login and retry', async () => {
      await page.locator('#prompt').fill('Local account draft');
      localSessionCount = readState().sessions.length;
      await page.locator('#account-button').click();
      await page.locator('#account-name-input').fill('工作账户'); await page.locator('#add-account-button').click();
      await page.locator('#account-login-code').filter({ hasText: 'TEST-1234' }).waitFor();
      newAccount = readState().activeAccountId; assert.notEqual(newAccount, 'local');
      assert.equal(await page.locator('.session-select').count(), 0);
      assert.equal(await switchRow('local').isDisabled(), true);
      await closeAccounts();
      await page.locator('#prompt').fill('Pending profile draft');
      for (const id of ['send-button', 'new-session', 'model-select', 'mode-select', 'settings-button', 'connection-button']) assert.equal(await page.locator(`#${id}`).isDisabled(), true, `${id} must be locked while login is pending`);
      assert.equal(await page.locator('#prompt').isDisabled(), false);
      assert.equal(await page.locator('#account-button').isDisabled(), false);
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#prompt').inputValue(), 'Pending profile draft');
      await page.locator('#account-button').click();
      await page.locator('#account-open-login').click();
      const external = await desktop.evaluate(() => globalThis.__tokyoUITest.external);
      assert.equal(external.at(-1), 'https://auth.x.ai/device');
      await page.locator('#account-copy-code').click();
      assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), 'TEST-1234');
      await page.locator('#account-cancel-login').click();
      await page.locator('#account-login-panel').waitFor({ state: 'hidden' });
      assert.match(await page.locator('#account-feedback').textContent(), /登录已取消/);
      assert.equal(await page.locator('#account-login-code').textContent(), '');
      assert.equal(await page.locator('#new-session').isDisabled(), false);
      await page.locator('#account-login').click();
      await page.locator('#account-login-panel').waitFor({ state: 'visible' });
      await desktop.evaluate(() => globalThis.__tokyoUITest.finishLogin(false));
      await page.waitForFunction(() => document.querySelector('#account-feedback').textContent.includes('登录未完成'));
      await page.locator('#account-login').click();
      await page.locator('#account-login-code').filter({ hasText: 'TEST-1234' }).waitFor();
      await desktop.evaluate(() => globalThis.__tokyoUITest.finishLogin(true));
      await ready();
      assert.equal(await page.locator('#account-name').textContent(), '工作账户');
      assert.ok((await page.locator('#account-list').textContent()).includes('tokyo@example.test'));
      assert.equal(readState().sessions.filter(s => s.accountId === newAccount).length, 1);
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
      await page.screenshot({ path: path.join(testRoot, 'accounts-compact.png') });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    });
    await stage('switch accounts restores the correct history, draft and saved active account', async () => {
      await closeAccounts();
      assert.equal(await page.locator('#prompt').inputValue(), 'Pending profile draft', 'login completion preserves a new-conversation draft');
      // Exercise a saved conversation separately from the new-conversation
      // draft; login no longer silently selects this bootstrap history entry.
      await page.locator('.session-select').first().click(); await idle();
      await page.locator('#prompt').fill('Work account chat'); await page.locator('#send-button').click(); await idle();
      await page.locator('#prompt').fill('Work account draft');
      await page.locator('#account-button').click(); await switchRow('local').click(); await ready(); await closeAccounts();
      assert.equal(await page.locator('#prompt').inputValue(), 'Local account draft');
      assert.equal(await page.locator('.session-select').count(), localSessionCount);
      assert.equal(await page.locator('.session-item.active .session-title').textContent(), 'WAIT image previews');
      await page.locator('#account-button').click(); await switchRow(newAccount).click(); await ready(); await closeAccounts();
      assert.equal(await page.locator('#prompt').inputValue(), 'Work account draft');
      assert.equal(await page.locator('.session-title').textContent(), 'Work account chat');
      await page.reload(); await ready();
      assert.equal(await page.locator('#account-name').textContent(), '工作账户');
      assert.equal(await page.locator('.session-title').textContent(), 'Work account chat');
      const saved = readState(); assert.equal(saved.sessions.length, localSessionCount + 1); assert.equal(saved.accounts.length, 2);
      assert.ok(!JSON.stringify(saved.accounts).includes('fixture-not-a-real-credential'));
    });
    await stage('account rename validates blanks and duplicates, saves with keyboard and persists', async () => {
      await page.locator('#account-button').click();
      assert.equal(await deleteRow('local').isDisabled(), true);
      assert.match(await accountRow('local').textContent(), /默认账户不可移除/);
      await renameRow(newAccount).click();
      await page.locator('#account-rename-input').fill('   '); await page.locator('#account-rename-save').click();
      assert.match(await page.locator('#account-rename-feedback').textContent(), /请输入账户名称/);
      assert.equal(readState().accounts.find(a => a.id === newAccount).name, '工作账户');
      await page.locator('#account-rename-input').fill('长'.repeat(61)); await page.locator('#account-rename-save').click();
      assert.match(await page.locator('#account-rename-feedback').textContent(), /不能超过 60/);
      await page.locator('#account-rename-input').fill('本机 Grok 账户'); await page.locator('#account-rename-save').click();
      await page.locator('#account-rename-feedback').filter({ hasText: /已存在|已使用|重复/ }).waitFor();
      assert.equal(await page.locator('#account-rename-dialog').isVisible(), true);
      await page.locator('#account-rename-input').fill('  工作账户・更新  '); await page.keyboard.press('Enter');
      await page.locator('#account-rename-dialog').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#account-name').textContent(), '工作账户・更新');
      assert.equal(readState().accounts.find(a => a.id === newAccount).name, '工作账户・更新');
      await deleteRow(newAccount).click();
      assert.equal(await page.locator('#account-delete-cancel').evaluate(el => el === document.activeElement), true);
      assert.match(await page.locator('#account-delete-description').textContent(), /不会注销你的 xAI/);
      await page.keyboard.press('Escape');
      await page.locator('#account-delete-dialog').waitFor({ state: 'hidden' });
      assert.equal(readState().accounts.length, 2);
      assert.equal(await deleteRow(newAccount).evaluate(el => el === document.activeElement), true);
      await deleteRow(newAccount).click(); await page.locator('#account-delete-cancel').click();
      assert.equal(readState().accounts.length, 2);
      const overflow = await page.locator('#accounts-dialog').evaluate(el => el.scrollWidth > el.clientWidth || el.getBoundingClientRect().bottom > innerHeight);
      assert.equal(overflow, false);
    });
    await stage('delete an inactive profile clears its login and history while preserving the current draft', async () => {
      await page.locator('#account-name-input').fill('待删除账户'); await page.locator('#add-account-button').click();
      await page.locator('#account-login-code').filter({ hasText: 'TEST-1234' }).waitFor();
      const removable = readState().activeAccountId;
      assert.equal(await deleteRow(newAccount).isDisabled(), true);
      assert.equal(await renameRow(removable).isDisabled(), true);
      await desktop.evaluate(() => globalThis.__tokyoUITest.finishLogin(true)); await ready(); await closeAccounts();
      await page.locator('#prompt').fill('Disposable profile chat'); await page.locator('#send-button').click(); await idle();
      await page.locator('#prompt').fill('Disposable profile draft');
      const profileDir = path.join(testRoot, 'data', 'accounts', removable);
      assert.equal(fs.existsSync(path.join(profileDir, 'grok', 'auth.json')), true);
      await page.locator('#account-button').click(); await switchRow(newAccount).click(); await ready(); await closeAccounts();
      await page.locator('#prompt').fill('Surviving work draft');
      await page.locator('#account-button').click(); await deleteRow(removable).click();
      assert.equal(await page.locator('#account-delete-current').isHidden(), true);
      await page.locator('#account-delete-confirm').click(); await page.locator('#account-delete-dialog').waitFor({ state: 'hidden' });
      await ready();
      assert.equal(await accountRow(removable).count(), 0);
      assert.equal(readState().activeAccountId, newAccount);
      assert.equal(readState().sessions.some(s => s.accountId === removable), false);
      assert.equal(fs.existsSync(profileDir), false);
      assert.equal(await page.locator('#prompt').inputValue(), 'Surviving work draft');
      assert.equal(await page.locator('.session-title').textContent(), 'Work account chat');
    });
    await stage('delete the current last profile restores local history and draft, clearing profile images', async () => {
      await switchRow('local').click(); await ready(); await closeAccounts();
      await page.locator('#prompt').fill('Keep local draft');
      await page.locator('#account-button').click(); await switchRow(newAccount).click(); await ready(); await closeAccounts();
      await page.locator('.session-select').first().click(); await ready();
      await page.locator('#prompt').fill('WAIT deleted profile image'); await page.locator('#send-button').click();
      await page.waitForFunction(() => !document.querySelector('#stop-button').hidden && !document.querySelector('#prompt').disabled);
      const sessionId = readState().sessions.find(s => s.accountId === newAccount).id;
      await desktop.evaluate((_e, data) => globalThis.__tokyoUITest.adapter.emit('event', { type: 'image', sessionId: data.sessionId, image: { src: `data:image/png;base64,${data.icon}`, alt: 'Deleted profile image' } }), { sessionId, icon: icon.toString('base64') });
      await page.locator('img[alt="Deleted profile image"]').waitFor();
      await page.locator('#stop-button').click(); await idle();
      await page.locator('#prompt').fill('Discard work draft');
      await page.locator('#account-button').click(); await deleteRow(newAccount).click();
      assert.equal(await page.locator('#account-delete-current').isVisible(), true);
      await page.screenshot({ path: path.join(testRoot, 'account-delete-compact.png') });
      await page.locator('#account-delete-confirm').click(); await page.locator('#account-delete-dialog').waitFor({ state: 'hidden' }); await ready();
      assert.equal(await page.locator('.account-row').count(), 1);
      assert.match(await page.locator('#account-feedback').textContent(), /已返回默认账户/);
      assert.equal(readState().activeAccountId, 'local');
      assert.equal(readState().sessions.length, localSessionCount);
      assert.equal(fs.existsSync(path.join(testRoot, 'data/accounts', newAccount)), false);
      await closeAccounts();
      assert.equal(await page.locator('#prompt').inputValue(), 'Keep local draft');
      assert.equal(await page.locator('img[alt="Deleted profile image"]').count(), 0);
      assert.equal(await page.locator('#image-preview').getAttribute('src'), null);
      assert.equal(await page.locator('.session-item.active .session-title').textContent(), 'WAIT image previews');
      await page.screenshot({ path: path.join(testRoot, 'account-deleted-compact.png') });
    });
    await stage('a full application restart does not recreate deleted profiles or their chats', async () => {
      await desktop.close();
      desktop = await _electron.launch({ args: launchArgs, env });
      page = await desktop.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setAudioMuted(true));
      await ready(); await page.locator('#account-button').click();
      assert.equal(await page.locator('.account-row').count(), 1);
      assert.equal(readState().activeAccountId, 'local');
      assert.equal(readState().accounts.length, 1);
      assert.equal(readState().sessions.length, localSessionCount);
      assert.equal(await page.locator('.session-select').count(), localSessionCount);
      assert.equal(await page.locator('#prompt').inputValue(), '');
    });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: results.length, packaged: process.argv.includes('--packaged'), realGenerations: 0, output: testRoot }));
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const rect = element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; };
      return {
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        scroller: { ...rect(document.querySelector('#conversation-scroll')), scrollTop: document.querySelector('#conversation-scroll').scrollTop },
        images: [...document.querySelectorAll('.chat-image')].map(figure => {
          const img = figure.querySelector('img');
          return { alt: img.alt, src: img.src.startsWith('data:') ? `${img.src.slice(0, 40)}… (${img.src.length} chars)` : img.src, complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, loading: img.loading, hidden: img.hidden, caption: figure.querySelector('figcaption')?.textContent, imageRect: rect(img), figureRect: rect(figure) };
        }),
      };
    }).catch(diagnosticError => ({ error: diagnosticError.message }));
    Object.assign(diagnostics, { errors, requestFailures });
    fs.writeFileSync(path.join(testRoot, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));
    console.error('Image diagnostics:', JSON.stringify(diagnostics));
    await page.screenshot({ path: path.join(testRoot, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await desktop.close();
    fs.writeFileSync(path.join(testRoot, 'results.json'), JSON.stringify({ results, errors, packaged: process.argv.includes('--packaged') }, null, 2));
  }
})().catch(error => { console.error(error); console.error(`QA output: ${testRoot}`); process.exitCode = 1; });
