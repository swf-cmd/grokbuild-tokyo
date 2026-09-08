'use strict';

// Exercises the production Electron bridge and UI with an isolated, offline CLI fixture.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const base = path.join(root, 'work', 'ui-attachments');
fs.mkdirSync(base, { recursive: true });
const testRoot = fs.mkdtempSync(path.join(base, 'run-'));
const workspace = path.join(testRoot, 'Workspace');
const executable = path.join(testRoot, process.platform === 'win32' ? 'grok.exe' : 'grok');
fs.mkdirSync(workspace); fs.mkdirSync(path.join(testRoot, 'data'));
fs.writeFileSync(executable, 'Offline fixture only');
fs.chmodSync(executable, 0o755);
const png = fs.readFileSync(path.join(root, 'src/renderer/assets/icon.png'));
const imageFile = path.join(workspace, '东京 photo.png');
const documentFile = path.join(workspace, 'notes.txt');
fs.writeFileSync(imageFile, png); fs.writeFileSync(documentFile, 'Attachment test 日本語 中文\n');
fs.writeFileSync(path.join(testRoot, 'data/conversations.json'), JSON.stringify({ version: 1, settings: { executable, workspace, musicEnabled: false, language: 'zh-CN' }, sessions: [] }));
const readState = () => JSON.parse(fs.readFileSync(path.join(testRoot, 'data/conversations.json'), 'utf8'));

(async () => {
  const env = { ...process.env, TOKYO_TEST_ROOT: testRoot };
  if (process.argv.includes('--packaged')) env.TOKYO_UI_SOURCE_ROOT = require('../scripts/package-paths.cjs').packagedArchive(root);
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await _electron.launch({ args: [path.join(__dirname, 'fixtures/ui-app.cjs')], env });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(10000);
  await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.setAudioMuted(true); });
  const errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  const ready = () => page.waitForFunction(() => document.querySelector('#connection-label').textContent.includes('已连接') && !document.querySelector('#account-button').disabled);
  const idle = () => page.waitForFunction(() => document.querySelector('#stop-button').hidden && !document.querySelector('#prompt').disabled);
  const drafts = count => page.waitForFunction(count => document.querySelectorAll('.attachment-draft').length === count && !document.querySelector('.attachment-pending'), count);
  const queueDialog = value => desktop.evaluate((_electron, value) => globalThis.__tokyoUITest.dialogs.push(value), value);
  const choose = async (files, count) => { await queueDialog({ canceled: false, filePaths: files }); await page.locator('#attach-button').click(); await drafts(count); };
  const clear = async () => { while (await page.locator('.attachment-remove').count()) await page.locator('.attachment-remove').first().click(); };
  const stage = async (name, action) => { await action(); results.push(name); console.log(`PASS ${name}`); };
  const send = async text => { await page.locator('#prompt').fill(text); await page.locator('#send-button').click(); await idle(); };
  let firstSession;
  try {
    await ready();
    await stage('native multi-select, cancel, image preview, remove and attachment-only send', async () => {
      assert.equal(await page.locator('#send-button').isDisabled(), true);
      await queueDialog({ canceled: true, filePaths: [] }); await page.locator('#attach-button').click(); await drafts(0);
      await choose([imageFile, documentFile], 2);
      assert.equal(await page.locator('#send-button').isEnabled(), true);
      await page.waitForFunction(() => document.querySelector('.attachment-draft img')?.naturalWidth > 0);
      await page.getByRole('button', { name: '移除附件：notes.txt', exact: true }).click(); await drafts(1);
      await choose([documentFile], 2);
      await send(''); await drafts(0);
      const calls = await desktop.evaluate(() => globalThis.__tokyoUITest.calls.filter(item => item.method === 'prompt'));
      assert.equal(calls.at(-1).text, '');
      assert.deepEqual(calls.at(-1).attachments.map(item => item.name), ['东京 photo.png', 'notes.txt']);
      firstSession = readState().sessions[0].id;
      assert.equal(readState().sessions[0].messages[0].attachments.length, 2);
      assert.equal(readState().sessions[0].messages[0].attachments.some(item => item.previewSrc), false);
      await page.waitForFunction(() => document.querySelector('.message.user .chat-image img')?.naturalWidth > 0);
      assert.equal(await page.locator('.message.user .attachment-card').count(), 2);
      assert.equal(await page.locator('#send-button').isDisabled(), true);
    });
    await stage('reading an upload does not flash or leave the original image in the answer', async () => {
      await choose([imageFile], 1);
      await page.locator('#prompt').fill('WAIT describe uploaded picture');
      await page.locator('#send-button').click();
      await page.waitForFunction(() => !document.querySelector('#stop-button').hidden);
      await desktop.evaluate((_electron, data) => {
        const fixture = globalThis.__tokyoUITest;
        const sessionId = fixture.calls.filter(item => item.method === 'prompt').at(-1).sessionId;
        const emit = update => fixture.adapter.emit('event', { type: 'tool', sessionId, toolCallId: 'read-upload', ...update });
        emit({ title: 'read_file', kind: 'other', status: 'pending' });
        emit({ title: 'Read `uploaded picture.png`', kind: 'read', status: 'in_progress', rawInput: { variant: 'ReadFile' } });
        emit({ status: 'completed', content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data } }] });
        fixture.adapter.emit('event', { type: 'text', sessionId, text: 'The picture shows a city.' });
      }, png.toString('base64'));
      await page.locator('.message.assistant').last().filter({ hasText: 'The picture shows a city.' }).waitFor();
      assert.equal(await page.locator('.message.assistant').last().locator('.chat-image').count(), 0);
      await page.waitForFunction(() => [...document.querySelectorAll('.message.user')].at(-1)?.querySelector('.chat-image img')?.naturalWidth > 0);
      await desktop.evaluate(() => {
        const adapter = globalThis.__tokyoUITest.adapter;
        for (const [sessionId, resolve] of adapter.pending) { resolve({ stopReason: 'end_turn' }); adapter.pending.delete(sessionId); }
      });
      await idle();
      assert.equal(await page.locator('.message.assistant').last().locator('.chat-image').count(), 0);
      assert.deepEqual(readState().sessions.find(item => item.id === firstSession).messages.at(-1).images, []);
    });
    await stage('reading text uploads never echoes embedded resources or resource links, including after reload', async () => {
      await choose([documentFile], 1);
      await page.locator('#prompt').fill('WAIT summarize uploaded document');
      await page.locator('#send-button').click();
      await page.waitForFunction(() => !document.querySelector('#stop-button').hidden);
      const embedded = { type: 'content', content: { type: 'resource', resource: { uri: 'notes.txt', mimeType: 'text/plain', text: fs.readFileSync(documentFile, 'utf8') } } };
      const linked = { type: 'content', content: { type: 'resource_link', uri: documentFile, name: 'notes.txt', mimeType: 'text/plain' } };
      const updates = [
        { title: 'read_file', kind: 'other', status: 'pending', content: [embedded] },
        { title: 'Read `notes.txt`', kind: 'read', status: 'in_progress', rawInput: { variant: 'ReadFile' }, content: [linked] },
        { status: 'completed', content: [embedded, linked] },
      ];
      for (const update of updates) {
        await desktop.evaluate((_electron, update) => {
          const fixture = globalThis.__tokyoUITest;
          const sessionId = fixture.calls.filter(item => item.method === 'prompt').at(-1).sessionId;
          fixture.adapter.emit('event', { type: 'tool', sessionId, toolCallId: 'read-document', ...update });
        }, update);
        await page.locator(`.message.assistant .tool-entry[data-tool-id="read-document"][data-status="${update.status}"]`).waitFor();
        assert.equal(await page.locator('.message.assistant').last().locator('.attachment-card').count(), 0, `${update.status} read result must remain inside the tool output`);
        assert.deepEqual(await page.locator('.message.user').last().locator('.attachment-name').allTextContents(), ['notes.txt']);
      }
      await desktop.evaluate(() => {
        const adapter = globalThis.__tokyoUITest.adapter;
        for (const [sessionId, resolve] of adapter.pending) {
          adapter.emit('event', { type: 'text', sessionId, text: 'The document contains a multilingual attachment test.' });
          resolve({ stopReason: 'end_turn' }); adapter.pending.delete(sessionId);
        }
      });
      await idle();
      const persisted = readState().sessions.find(item => item.id === firstSession).messages;
      assert.deepEqual(persisted.at(-1).attachments || [], []);
      assert.deepEqual(persisted.at(-2).attachments.map(item => item.name), ['notes.txt']);
      await page.reload(); await ready();
      await page.locator('.session-select').first().click(); await idle();
      await page.locator('.message.assistant').last().filter({ hasText: 'The document contains a multilingual attachment test.' }).waitFor();
      assert.equal(await page.locator('.message.assistant').last().locator('.attachment-card').count(), 0);
      assert.deepEqual(await page.locator('.message.user').last().locator('.attachment-name').allTextContents(), ['notes.txt']);
    });
    await stage('draft attachments stay with their conversation and survive IPC send rejection', async () => {
      await choose([documentFile], 1); await page.locator('#prompt').fill('First draft');
      await page.locator('#new-session').click(); await drafts(0);
      await choose([imageFile], 1); await page.locator('#prompt').fill('Second draft');
      await page.locator('.session-select').first().click(); await idle(); await drafts(1);
      assert.equal(await page.locator('#prompt').inputValue(), 'First draft');
      assert.equal(await page.locator('.attachment-draft .attachment-name').textContent(), 'notes.txt');
      await page.locator('#new-session').click(); await drafts(1);
      assert.equal(await page.locator('#prompt').inputValue(), 'Second draft');
      await send('Second conversation');
      await choose([documentFile], 1); await page.locator('#prompt').fill('Recover this draft');
      await desktop.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get('tokyo:send');
        ipcMain.removeHandler('tokyo:send');
        ipcMain.handle('tokyo:send', (...args) => { ipcMain.removeHandler('tokyo:send'); ipcMain.handle('tokyo:send', original); throw new Error('Fixture: pre-send failure'); });
      });
      await page.locator('#send-button').click();
      await page.locator('.toast').filter({ hasText: 'Fixture: pre-send failure' }).waitFor(); await drafts(1);
      assert.equal(await page.locator('#prompt').inputValue(), 'Recover this draft');
      assert.equal(await page.locator('#send-button').isEnabled(), true);
      await page.locator('#new-session').click();
      await page.locator('.session-select').filter({ hasText: 'Second conversation' }).click(); await idle(); await drafts(1);
      assert.equal(await page.locator('#prompt').inputValue(), 'Recover this draft');
      await send('Retry succeeds'); await drafts(0);
    });
    await stage('clipboard images and dropped files use the real attachment bridge', async () => {
      await page.evaluate(data => {
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'clipboard.png', { type: 'image/png' }));
        document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
      }, png.toString('base64'));
      await drafts(1);
      await page.evaluate(() => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File(['dropped file'], 'dragged.txt', { type: 'text/plain' }));
        document.querySelector('#composer-form').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      });
      await drafts(2);
      assert.deepEqual(await page.locator('.attachment-draft .attachment-name').allTextContents(), ['clipboard.png', 'dragged.txt']);
      await send('Clipboard and drag');
      const calls = await desktop.evaluate(() => globalThis.__tokyoUITest.calls.filter(item => item.method === 'prompt'));
      assert.deepEqual(calls.at(-1).attachments.map(item => item.name), ['clipboard.png', 'dragged.txt']);
    });
    await stage('count and byte limits reject oversized drafts without losing text', async () => {
      await page.locator('#prompt').fill('Keep this text');
      for (const scenario of ['count', 'single', 'total']) {
        await page.evaluate(scenario => {
          const files = scenario === 'count' ? Array.from({ length: 11 }, (_, i) => new File(['x'], `${i}.txt`)) : scenario === 'single' ? [new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'too-big.bin')] : Array.from({ length: 3 }, (_, i) => new File([new Uint8Array(18 * 1024 * 1024)], `${i}.bin`));
          const dataTransfer = new DataTransfer(); files.forEach(file => dataTransfer.items.add(file));
          document.querySelector('#composer-form').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
        }, scenario);
        await page.locator('.toast').filter({ hasText: scenario === 'count' ? '10 个附件' : scenario === 'single' ? '20 MB' : '50 MB' }).waitFor();
        await drafts(0); assert.equal(await page.locator('#prompt').inputValue(), 'Keep this text');
      }
      await page.locator('#prompt').fill('');
    });
    await stage('asynchronous chooser results stay with the original conversation', async () => {
      await desktop.evaluate(({ dialog }) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return new Promise(resolve => { globalThis.__tokyoUITest.resolveChooser = resolve; }); };
      });
      await page.locator('#attach-button').click();
      await page.locator('.attachment-pending').waitFor();
      await page.locator('#new-session').click(); await drafts(0);
      await desktop.evaluate((_electron, file) => globalThis.__tokyoUITest.resolveChooser({ canceled: false, filePaths: [file] }), documentFile);
      await page.waitForTimeout(150);
      assert.equal(await page.locator('.attachment-draft').count(), 0);
      await page.locator('.session-select').filter({ hasText: 'Second conversation' }).click(); await idle(); await drafts(1);
      assert.equal(await page.locator('.attachment-draft .attachment-name').textContent(), 'notes.txt');
    });
    await stage('each account keeps its own attachment drafts', async () => {
      await page.locator('#prompt').fill('Local attachment draft');
      await page.locator('#account-button').click(); await page.locator('#account-name-input').fill('Attachment profile'); await page.locator('#add-account-button').click();
      await page.locator('#account-login-code').filter({ hasText: 'TEST-1234' }).waitFor();
      const accountId = readState().activeAccountId;
      await desktop.evaluate(() => globalThis.__tokyoUITest.finishLogin(true)); await ready();
      await page.locator('[data-close-dialog="accounts-dialog"]').click(); await drafts(0);
      // Explicitly leave saved history: new-conversation drafts use a separate
      // key and must remain selected after switching away and returning.
      await page.locator('#new-session').click();
      await choose([imageFile], 1); await page.locator('#prompt').fill('Profile attachment draft');
      const switchTo = async id => { await page.locator('#account-button').click(); await page.locator(`.account-row[data-account-id="${id}"] [data-account-action="switch"]`).click(); await ready(); await page.locator('[data-close-dialog="accounts-dialog"]').click(); };
      await switchTo('local'); await drafts(1);
      assert.equal(await page.locator('#prompt').inputValue(), 'Local attachment draft');
      assert.equal(await page.locator('.attachment-draft .attachment-name').textContent(), 'notes.txt');
      await switchTo(accountId); await drafts(1);
      assert.equal(await page.locator('#prompt').inputValue(), 'Profile attachment draft');
      assert.equal(await page.locator('.attachment-draft .attachment-name').textContent(), '东京 photo.png');
      const localAttachmentDirectory = path.join(testRoot, 'data/attachments/local');
      const previousLocalAttachments = fs.readdirSync(localAttachmentDirectory).sort();
      await page.evaluate(() => {
        const original = FileReader.prototype.readAsDataURL;
        FileReader.prototype.readAsDataURL = function(file) {
          FileReader.prototype.readAsDataURL = original;
          this.addEventListener('loadend', () => { window.__attachmentReadFinished = true; });
          window.__finishAttachmentRead = () => original.call(this, file);
        };
        const clipboardData = new DataTransfer(); clipboardData.items.add(new File(['private profile content'], 'profile-private.txt'));
        document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
      });
      await page.locator('.attachment-pending').waitFor();
      await switchTo('local');
      await page.evaluate(() => window.__finishAttachmentRead());
      await page.waitForFunction(() => window.__attachmentReadFinished);
      assert.deepEqual(fs.readdirSync(localAttachmentDirectory).sort(), previousLocalAttachments, 'a delayed read must never import private files into the newly selected account');
      await drafts(1); assert.equal(await page.locator('.attachment-draft .attachment-name').textContent(), 'notes.txt');
      await clear(); await page.locator('#prompt').fill('');
    });
    await stage('streamed Markdown and embedded attachments render, save, and reload', async () => {
      await page.locator('#prompt').fill('WAIT attachment response'); await page.locator('#send-button').click();
      await page.waitForFunction(() => !document.querySelector('#stop-button').hidden && !document.querySelector('#prompt').disabled);
      // WAIT keeps the fixture turn active, so use the current engine session ID.
      const sessionId = readState().sessions.find(session => session.title === 'Second conversation').id;
      const resultFile = path.join(workspace, 'report.csv'); fs.writeFileSync(resultFile, 'name,value\nTokyo,42\n');
      await desktop.evaluate((_electron, { sessionId }) => {
        const adapter = globalThis.__tokyoUITest.adapter;
        adapter.emit('event', { type: 'text', sessionId, text: '[Download report](report.csv)' });
        adapter.emit('event', { type: 'attachment', sessionId, attachment: { id: 'embedded-fixture', name: '<unsafe>.txt', mimeType: 'text/plain', size: 8, src: 'data:text/plain;base64,ZW1iZWRkZWQ=' } });
        adapter.emit('event', { type: 'tool', sessionId, toolCallId: 'generate-report', title: 'generate_file', kind: 'edit', status: 'completed', content: [{ type: 'content', content: { type: 'resource', resource: { uri: 'generated.txt', mimeType: 'text/plain', text: 'A newly generated report.' } } }] });
      }, { sessionId });
      const report = page.locator('.message.assistant .attachment-card').filter({ hasText: 'Download report' });
      const embedded = page.locator('.message.assistant .attachment-card').filter({ hasText: '<unsafe>.txt' });
      const generated = page.locator('.message.assistant .attachment-card').filter({ hasText: 'generated.txt' });
      await report.waitFor(); await embedded.waitFor(); await generated.waitFor();
      assert.equal(await page.locator('.attachment-card unsafe').count(), 0);
      await queueDialog({ canceled: true }); await page.locator('.message-body a').filter({ hasText: 'Download report' }).click();
      await queueDialog({ canceled: false, filePath: path.join(testRoot, 'saved-report.csv') }); await report.locator('.attachment-save').click();
      await page.locator('.toast').filter({ hasText: 'saved-report.csv' }).waitFor();
      assert.equal(await desktop.evaluate(() => globalThis.__tokyoUITest.calls.filter(item => item.method === 'showSaveDialog').at(-1).options.defaultPath), 'report.csv');
      assert.equal(fs.readFileSync(path.join(testRoot, 'saved-report.csv'), 'utf8'), fs.readFileSync(resultFile, 'utf8'));
      await queueDialog({ canceled: false, filePath: path.join(testRoot, 'embedded.txt') }); await embedded.locator('.attachment-save').click();
      await page.locator('.toast').filter({ hasText: 'embedded.txt' }).waitFor(); assert.equal(fs.readFileSync(path.join(testRoot, 'embedded.txt'), 'utf8'), 'embedded');
      await queueDialog({ canceled: false, filePath: path.join(testRoot, 'generated.txt') }); await generated.locator('.attachment-save').click();
      await page.locator('.toast').filter({ hasText: 'generated.txt' }).waitFor(); assert.equal(fs.readFileSync(path.join(testRoot, 'generated.txt'), 'utf8'), 'A newly generated report.');
      await page.locator('#stop-button').click(); await idle(); await page.reload(); await ready();
      await page.locator('.session-select').filter({ hasText: 'Second conversation' }).click(); await idle();
      await report.waitFor(); await embedded.waitFor(); await generated.waitFor();
      const persisted = readState().sessions.find(session => session.id === sessionId).messages.at(-1).attachments;
      assert.equal(persisted.length, 3);
      assert.ok(readState().sessions.find(session => session.id === firstSession).messages[0].attachments.length === 2);
    });
    await stage('compact layout and all seven translated attachment controls', async () => {
      await choose([imageFile, documentFile], 2);
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
      await page.locator('#settings-button').click();
      const catalogs = require('../src/locales.js');
      for (const language of ['zh-CN', 'ja', 'en', 'ko', 'es', 'de', 'fr']) {
        await page.locator('#language-select').selectOption(language);
        assert.equal(await page.locator('#attach-button').getAttribute('aria-label'), catalogs[language]['添加图片或附件']);
        assert.equal(await page.locator('#attachment-drafts').getAttribute('aria-label'), catalogs[language]['待发送附件']);
        assert.equal(await page.locator('.attachment-save').first().textContent(), catalogs[language]['保存附件']);
      }
      await page.locator('[data-close-dialog="settings-dialog"]').click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('#composer-form').evaluate(el => el.scrollWidth > el.clientWidth), false);
      if (await page.locator('#scroll-bottom').isVisible()) {
        assert.equal(await page.evaluate(() => document.querySelector('#scroll-bottom').getBoundingClientRect().bottom <= document.querySelector('#composer-form').getBoundingClientRect().top), true);
        await page.locator('#scroll-bottom').click();
        await page.waitForFunction(() => { const scroll = document.querySelector('#conversation-scroll'); return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 50; });
      }
      await page.screenshot({ path: path.join(testRoot, 'attachments-compact.png') });
    });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: results.length, testRoot }));
  } catch (error) {
    await page.screenshot({ path: path.join(testRoot, 'failure.png') }).catch(() => {});
    console.error(error); process.exitCode = 1;
  } finally { await desktop.close(); }
})();
