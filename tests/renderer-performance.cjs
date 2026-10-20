'use strict';

// Real Electron/IPC regression: rendering cost must follow the changed reply,
// and typing must preserve an already decoded attachment thumbnail.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const base = path.join(root, 'work', 'renderer-performance');
fs.mkdirSync(base, { recursive: true });
const profile = fs.mkdtempSync(path.join(base, 'run-'));
const workspace = path.join(profile, 'Workspace');
const executable = path.join(profile, process.platform === 'win32' ? 'grok.exe' : 'grok');
fs.mkdirSync(workspace); fs.mkdirSync(path.join(profile, 'data'));
fs.writeFileSync(executable, 'Offline fixture only'); fs.chmodSync(executable, 0o755);
const history = Array.from({ length: 60 }, (_, index) => ({
  id: `saved-${index}`, role: 'assistant', status: 'complete',
  text: `Reply ${index}\n\n${'[reference](https://example.test) `value` '.repeat(100)}\n\n\`\`\`js\nconsole.log("saved");\n\`\`\``,
  thought: index === 0 ? 'Saved reasoning' : '', tools: [], createdAt: new Date().toISOString(),
}));
fs.writeFileSync(path.join(profile, 'data', 'conversations.json'), JSON.stringify({
  version: 1, settings: { executable, workspace, musicEnabled: false, language: 'en' },
  sessions: [{ id: 'history', title: 'Rendering history', cwd: workspace, model: 'grok-4.6', mode: 'medium', messages: history }],
}));

(async () => {
  const env = { ...process.env, TOKYO_TEST_ROOT: profile };
  if (process.argv.includes('--packaged')) env.TOKYO_UI_SOURCE_ROOT = require('../scripts/package-paths.cjs').packagedArchive(root);
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await _electron.launch({ args: ['--mute-audio', path.join(__dirname, 'fixtures', 'ui-app.cjs')], env });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.waitForFunction(() => !document.querySelector('#connection-button').disabled);
    const metadata = await page.evaluate(() => window.tokyo.initialState());
    assert.equal(metadata.sessions.length, 1);
    assert.equal(Object.hasOwn(metadata.sessions[0], 'messages'), false, 'sidebar snapshots must omit full history');
    assert.equal(metadata.sessions[0].messageCount, 60);
    await page.getByRole('button', { name: 'Rendering history', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.message').length === 60);
    await page.evaluate(() => {
      window.__savedArticles = [...document.querySelectorAll('.message')];
      document.querySelector('.thought-details').open = true;
      // A reply is read either whole (parse) or once by the lexer, after which
      // only its changed blocks go through the parser.
      window.__parseCount = 0; window.__blockParses = 0;
      const { parse, lexer, parser } = window.marked;
      window.marked = {
        ...window.marked,
        parse(...args) { window.__parseCount++; return parse.apply(this, args); },
        lexer(...args) { window.__parseCount++; return lexer.apply(this, args); },
        parser(tokens, ...args) { window.__blockParses += tokens.length; return parser.call(this, tokens, ...args); },
      };
    });
    await page.locator('#prompt').fill('WAIT stream performance');
    await page.locator('#send-button').click();
    await page.waitForFunction(() => !document.querySelector('#stop-button').hidden && !document.querySelector('#prompt').disabled);
    for (let index = 0; index < 6; index++) {
      await desktop.evaluate((_, index) => {
        const test = globalThis.__tokyoUITest;
        const sessionId = test.calls.filter(call => call.method === 'prompt').at(-1).sessionId;
        test.adapter.emit('event', { type: 'text', sessionId, text: `chunk-${index} ` });
      }, index);
      await page.locator('.message').last().filter({ hasText: `chunk-${index}` }).waitFor();
    }
    const rendered = await page.evaluate(() => ({
      parses: window.__parseCount,
      blockParses: window.__blockParses,
      preserved: window.__savedArticles.every((article, index) => document.querySelectorAll('.message')[index] === article),
      thoughtOpen: document.querySelector('.thought-details').open,
      copyButtons: document.querySelectorAll('.copy-code').length,
    }));
    assert.equal(rendered.preserved, true, 'streaming must leave completed reply nodes in place');
    assert.equal(rendered.thoughtOpen, true);
    assert.equal(rendered.copyButtons, 60, 'cached code blocks must not gain duplicate copy buttons');
    assert.ok(rendered.parses >= 6 && rendered.parses <= 8, `six chunks parsed ${rendered.parses} replies`);
    // Each chunk extends the reply's one paragraph: only that block is rendered again.
    assert.ok(rendered.blockParses >= 6 && rendered.blockParses <= 8, `six chunks rendered ${rendered.blockParses} blocks`);

    // After a boundary freezes the progress text and a tool returns a large
    // diff, each later chunk parses only the growing answer and leaves the
    // diff's text alone.
    const diff = { type: 'diff', path: 'src/large.js', oldText: 'old line\n'.repeat(20000), newText: 'new line\n'.repeat(20000) };
    await desktop.evaluate((_, diff) => {
      const test = globalThis.__tokyoUITest;
      const sessionId = test.calls.filter(call => call.method === 'prompt').at(-1).sessionId;
      test.adapter.emit('event', { type: 'tool', sessionId, toolCallId: 'large-edit', title: 'Edit src/large.js', status: 'completed', content: [diff] });
      test.adapter.emit('event', { type: 'response-boundary', sessionId });
      test.adapter.emit('event', { type: 'text', sessionId, text: 'answer-0 ' });
    }, diff);
    await page.locator('.message').last().filter({ hasText: 'answer-0' }).waitFor();
    await page.evaluate(() => {
      window.__frozenParses = 0; window.__diffSerializations = 0;
      const { parse, lexer } = window.marked;
      window.marked = {
        ...window.marked,
        parse(text, ...rest) { if (String(text).includes('chunk-0')) window.__frozenParses++; return parse.call(this, text, ...rest); },
        lexer(text, ...rest) { if (String(text).includes('chunk-0')) window.__frozenParses++; return lexer.call(this, text, ...rest); },
      };
      const stringify = JSON.stringify;
      JSON.stringify = function(value, ...rest) { if (value?.type === 'diff') window.__diffSerializations++; return stringify.call(this, value, ...rest); };
    });
    for (let index = 1; index <= 4; index++) {
      await desktop.evaluate((_, index) => {
        const test = globalThis.__tokyoUITest;
        const sessionId = test.calls.filter(call => call.method === 'prompt').at(-1).sessionId;
        test.adapter.emit('event', { type: 'text', sessionId, text: `answer-${index} ` });
      }, index);
      await page.locator('.message').last().filter({ hasText: `answer-${index}` }).waitFor();
    }
    assert.deepEqual(await page.evaluate(() => ({ frozen: window.__frozenParses, diffs: window.__diffSerializations })), { frozen: 0, diffs: 0 },
      'later chunks must not parse frozen progress text or serialize an unchanged tool again');
    // A long chunk is followed at once, not by a smooth scroll still on its way
    // that the next frame would read as the user scrolling up.
    await desktop.evaluate(() => {
      const test = globalThis.__tokyoUITest;
      const sessionId = test.calls.filter(call => call.method === 'prompt').at(-1).sessionId;
      test.adapter.emit('event', { type: 'text', sessionId, text: `\n\n${'long-line\n\n'.repeat(40)}long-end` });
    });
    await page.locator('.message').last().filter({ hasText: 'long-end' }).waitFor();
    assert.ok(await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
      const scroller = document.querySelector('#conversation-scroll');
      resolve(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2);
    }))), 'a streaming reply stays scrolled to its latest line');
    // The same image shown twice keeps both figures when the reply renders again.
    for (const text of ['\n\n![](twice.png)\n\n![](twice.png)\n\ntwice-end', ' after-twice']) {
      await desktop.evaluate((_, text) => {
        const test = globalThis.__tokyoUITest;
        const sessionId = test.calls.filter(call => call.method === 'prompt').at(-1).sessionId;
        test.adapter.emit('event', { type: 'text', sessionId, text });
      }, text);
      await page.locator('.message').last().filter({ hasText: text.trim().split('\n').at(-1) }).waitFor();
    }
    assert.equal(await page.locator('.message').last().locator('.chat-image').count(), 2, 'a repeated image must not collapse into one');

    await desktop.evaluate(() => {
      for (const [sessionId, resolve] of globalThis.__tokyoUITest.adapter.pending) {
        resolve({ stopReason: 'end_turn' }); globalThis.__tokyoUITest.adapter.pending.delete(sessionId);
      }
    });
    await page.waitForFunction(() => document.querySelector('#stop-button').hidden);
    assert.equal(await page.evaluate(() => window.__savedArticles.every((article, index) => document.querySelectorAll('.message')[index] === article)), true, 'final full snapshot must preserve completed replies');

    // A batch of sidebar metadata must retain the loaded conversation and only
    // perform one list replacement, even when many sessions change together.
    await page.evaluate(() => {
      window.__listClears = 0;
      const list = document.querySelector('#session-list');
      const replace = list.replaceChildren.bind(list);
      list.replaceChildren = (...args) => { window.__listClears++; return replace(...args); };
      window.__beforeBatchParses = window.__parseCount;
    });
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('tokyo:event', {
      type: 'sessions-updated', sessions: Array.from({ length: 100 }, (_, index) => ({
        id: index === 0 ? 'history' : `metadata-${index}`, title: `Metadata ${index}`, modelSelectionVerified: false,
      })),
    }));
    await page.waitForFunction(() => document.querySelectorAll('.session-select').length === 100);
    assert.deepEqual(await page.evaluate(() => ({ clears: window.__listClears, retained: document.querySelectorAll('.message').length, parses: window.__parseCount - window.__beforeBatchParses })), { clears: 1, retained: 62, parses: 0 });

    const imageFile = path.join(root, 'src', 'renderer', 'assets', 'icon.png');
    await desktop.evaluate((_, imageFile) => globalThis.__tokyoUITest.dialogs.push({ canceled: false, filePaths: [imageFile] }), imageFile);
    await page.locator('#attach-button').click();
    await page.waitForFunction(() => document.querySelector('.attachment-draft img')?.naturalWidth > 0);
    await page.evaluate(() => { window.__draftImage = document.querySelector('.attachment-draft img'); });
    await page.locator('#prompt').pressSequentially('Typing keeps the thumbnail decoded.');
    assert.equal(await page.evaluate(() => window.__draftImage === document.querySelector('.attachment-draft img')), true);
    assert.equal(await page.locator('.composer').evaluate(element => getComputedStyle(element).backdropFilter), 'none');
    await page.locator('.attachment-remove').click();
    await page.waitForFunction(() => document.querySelectorAll('.attachment-draft').length === 0);
    assert.deepEqual(errors, []);
    console.log(`PASS renderer cache, metadata batching, composer previews (${rendered.parses} parses for six streamed chunks)`);
  } finally {
    await desktop.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
