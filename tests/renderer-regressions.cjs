'use strict';

// Renderer regressions: a conversation stuck as running, HTML in replies,
// streaming that redraws only what changed, scrolling to the latest message,
// clicks and focus during background updates, dialogs and the session menu.
// Only the CLI is a fixture; main, preload, controller and renderer are real.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const base = path.join(root, 'work', 'renderer-regressions');
fs.mkdirSync(base, { recursive: true });
const profile = fs.mkdtempSync(path.join(base, 'run-'));
const workspace = path.join(profile, 'Workspace');
const executable = path.join(profile, process.platform === 'win32' ? 'grok.exe' : 'grok');
fs.mkdirSync(workspace); fs.mkdirSync(path.join(profile, 'data'));
fs.writeFileSync(executable, 'Offline fixture only'); fs.chmodSync(executable, 0o755);
fs.writeFileSync(path.join(workspace, 'report.csv'), 'a,b\n1,2\n');
const reportURL = pathToFileURL(path.join(workspace, 'report.csv')).href;
const now = Date.now();
const message = (id, role, text) => ({ id, role, text, status: 'complete', createdAt: new Date(now).toISOString(), tools: [] });
const conversation = (id, title, age, messages) => ({ id, title, cwd: workspace, model: 'grok-4.6', mode: 'medium', createdAt: now - age, updatedAt: now - age, messages });
const markup = [
  'Press <kbd>Ctrl</kbd>+<kbd>C</kbd>, then read H<sub>2</sub>O.',
  '<details>\n<summary>More</summary>\n\nHidden **body** text\n\n</details>',
  '- [x] finished step\n- [ ] open step',
  '| Left | Center | Right |\n|:--|:-:|--:|\n| 1 | 2 | 3 |',
].join('\n\n');
fs.writeFileSync(path.join(profile, 'data', 'conversations.json'), JSON.stringify({
  version: 1, settings: { executable, workspace, musicEnabled: false, language: 'en' },
  sessions: [
    conversation('aaaaaaaa-0000-4000-8000-000000000001', 'Alpha', 1000, [message('a1', 'user', 'hi alpha')]),
    conversation('bbbbbbbb-0000-4000-8000-000000000002', 'Bravo', 2000, [message('b1', 'user', 'hi bravo')]),
    conversation('cccccccc-0000-4000-8000-000000000003', 'Charlie', 3000, [message('c1', 'user', 'hi charlie')]),
    conversation('dddddddd-0000-4000-8000-000000000004', 'Markup', 4000, [message('m1', 'user', 'format it'), message('m2', 'assistant', markup)]),
    conversation('eeeeeeee-0000-4000-8000-000000000005', 'Files', 5000, [message('f1', 'user', 'make a report'), message('f2', 'assistant', `Saved [the report](${reportURL}).`)]),
  ],
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
  const results = { passed: 0, failed: 0 };
  const stage = async (name, run) => {
    try { await run(); results.passed++; console.log(`PASS ${name}`); }
    catch (error) {
      results.failed++; console.log(`FAIL ${name}: ${error.message}`);
      await page.screenshot({ path: path.join(profile, `failure-${results.failed}.png`) }).catch(() => {});
    }
  };
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const select = async title => {
    await page.locator('.session-select', { hasText: title }).click();
    await page.waitForFunction(title => document.querySelector('#breadcrumb-title').textContent === title && !document.querySelector('.session-select').disabled, title);
  };
  const emit = event => desktop.evaluate((_, event) => {
    const adapter = globalThis.__tokyoUITest.adapter;
    adapter.emit('event', { sessionId: [...adapter.pending.keys()][0], ...event });
  }, event);
  const finish = () => desktop.evaluate(() => {
    const adapter = globalThis.__tokyoUITest.adapter;
    for (const [id, resolve] of adapter.pending) { resolve({ stopReason: 'end_turn' }); adapter.pending.delete(id); }
  });
  const startReply = async text => {
    await page.locator('#prompt').fill(text);
    await page.locator('#send-button').click();
    await page.waitForFunction(() => !document.querySelector('#stop-button').hidden);
    // Output is shown once the reply it belongs to is on screen.
    await page.waitForFunction(() => document.querySelector('.message:last-child .streaming-caret'));
  };
  const idle = () => page.waitForFunction(() => document.querySelector('#stop-button').hidden && document.querySelector('#running-badge').hidden);
  try {
    await page.waitForFunction(() => !document.querySelector('#connection-button').disabled && !document.querySelector('#settings-button').disabled);

    await stage('a reply opened mid-stream and later renamed does not come back as running', async () => {
      await select('Alpha');
      await startReply('WAIT stale status');
      await select('Bravo'); await select('Alpha');
      await finish(); await idle();
      await page.locator('.session-item.active').hover();
      await page.locator('.session-item.active .session-more').click();
      await page.locator('#menu-rename').click();
      await page.locator('#rename-input').fill('Alpha renamed');
      await page.locator('#rename-form button[type="submit"]').click();
      await page.waitForFunction(() => !document.querySelector('#rename-dialog').open);
      await settle();
      assert.equal(await page.locator('#stop-button').isHidden(), true, 'Stop is not offered');
      assert.equal(await page.locator('#running-badge').isHidden(), true, 'nothing counts as running');
      assert.equal(await page.locator('#connection-button').isDisabled(), false);
      await page.locator('#prompt').fill('next message');
      await page.locator('#prompt').press('Enter');
      await page.waitForFunction(() => document.querySelector('#prompt').value === '');
      // The composer clears at once; the prompt reaches the CLI a moment later
      // (on CI runners, after this check had already read the calls).
      const prompts = () => desktop.evaluate(() => globalThis.__tokyoUITest.calls.filter(call => call.method === 'prompt').map(call => call.text));
      let sent = await prompts();
      for (const deadline = Date.now() + 10000; sent.length < 2 && Date.now() < deadline; sent = await prompts()) await page.waitForTimeout(50);
      assert.deepEqual(sent, ['WAIT stale status', 'next message']);
      await idle();
    });

    await stage('HTML in a reply keeps its structure; task boxes and table alignment show', async () => {
      await select('Markup');
      const reply = page.locator('.message.assistant .response-content').last();
      assert.deepEqual(await reply.locator('kbd').allTextContents(), ['Ctrl', 'C']);
      assert.equal(await reply.locator('sub').textContent(), '2');
      assert.match(await reply.locator('details').textContent(), /Hidden body text/);
      assert.deepEqual(await reply.locator('li').allTextContents(), ['☑ finished step', '☐ open step']);
      assert.deepEqual(await reply.locator('td').evaluateAll(cells => cells.map(cell => cell.getAttribute('align'))), ['left', 'center', 'right']);
    });

    await stage('a file: link in a reply saves the attachment it names', async () => {
      await select('Files');
      await page.locator('.message.assistant .attachment-card').first().waitFor();
      await desktop.evaluate(() => { globalThis.__tokyoUITest.dialogs.push({ canceled: true }); });
      const saves = () => desktop.evaluate(() => globalThis.__tokyoUITest.calls.filter(call => call.method === 'showSaveDialog').length);
      const before = await saves();
      await page.locator('.message.assistant a', { hasText: 'the report' }).click();
      await page.waitForTimeout(300);
      assert.equal(await saves(), before + 1);
      assert.equal(await page.locator('.toast').filter({ hasText: 'not a web address' }).count(), 0);
    });

    await stage('streaming redraws only what changed: open outputs keep their scroll, finished blocks their nodes', async () => {
      await select('Charlie');
      await startReply('WAIT stream');
      await emit({ type: 'thought', text: Array.from({ length: 200 }, (_, index) => `thinking line ${index}`).join('\n') });
      await emit({ type: 'tool', toolCallId: 'big', title: 'Big output', status: 'completed', content: Array.from({ length: 400 }, (_, index) => `output line ${index}`).join('\n') });
      await emit({ type: 'text', text: 'First paragraph stays put.\n\n```js\nconst kept = true;\n```\n\nSecond' });
      await page.locator('.tool-entry').waitFor();
      await page.locator('.tool-entry summary').click();
      await page.locator('.thought-details summary').click();
      await page.evaluate(() => {
        document.querySelector('.tool-entry pre').scrollTop = 1500;
        document.querySelector('.thought-content').scrollTop = 1200;
        const first = document.querySelector('.message.assistant .response-content p');
        first.dataset.marker = 'kept';
        const range = document.createRange(); range.selectNodeContents(first);
        getSelection().removeAllRanges(); getSelection().addRange(range);
      });
      for (const text of [' paragraph grows', ' and grows', '\n\nThird paragraph.']) await emit({ type: 'text', text });
      await page.locator('.message').last().filter({ hasText: 'Third paragraph.' }).waitFor();
      await settle();
      const after = await page.evaluate(() => ({
        tool: document.querySelector('.tool-entry pre').scrollTop, thought: document.querySelector('.thought-content').scrollTop,
        toolOpen: document.querySelector('.tool-entry').open, thoughtOpen: document.querySelector('.thought-details').open,
        kept: document.querySelector('.message.assistant .response-content p')?.dataset.marker,
        selection: getSelection().toString(), copyButtons: document.querySelectorAll('.message.assistant .copy-code').length,
      }));
      assert.deepEqual(after, { tool: 1500, thought: 1200, toolOpen: true, thoughtOpen: true, kept: 'kept', selection: 'First paragraph stays put.', copyButtons: 1 });
      // A later update of the same tool appends to it in place.
      await emit({ type: 'tool', toolCallId: 'big', title: 'Big output', status: 'completed', content: Array.from({ length: 401 }, (_, index) => `output line ${index}`).join('\n') });
      await page.waitForFunction(() => document.querySelector('.tool-entry pre').textContent.includes('output line 400'));
      assert.equal(await page.evaluate(() => document.querySelector('.tool-entry pre').scrollTop), 1500);
      await finish(); await idle();
      assert.equal(await page.locator('.message.assistant').last().locator('.copy-code').count(), 1);
    });

    await stage('"Back to latest" during a fast reply lands on the latest message and keeps following', async () => {
      await select('Charlie');
      await startReply('WAIT scroll');
      for (let index = 0; index < 30; index++) await emit({ type: 'text', text: `\n\nfiller ${index}\n\n${'more text '.repeat(40)}` });
      await page.waitForFunction(() => document.querySelector('.message:last-child')?.textContent.includes('filler 29'));
      await page.evaluate(() => document.querySelector('#conversation-scroll').scrollTo({ top: 0, behavior: 'instant' }));
      await page.locator('#scroll-bottom').waitFor({ state: 'visible' });
      await page.locator('#scroll-bottom').click();
      for (let index = 0; index < 12; index++) await emit({ type: 'text', text: `\n\nburst ${index}\n\n${'streamed words '.repeat(60)}` });
      await page.waitForFunction(() => document.querySelector('.message:last-child')?.textContent.includes('burst 11'));
      await page.waitForTimeout(300);
      const gap = await page.evaluate(() => { const scroller = document.querySelector('#conversation-scroll'); return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight; });
      assert.ok(gap < 100, `${gap}px from the latest message`);
      await finish(); await idle();
    });

    await stage('a background update during a press keeps the click, and keyboard focus stays on its row', async () => {
      await select('Alpha renamed');
      await startReply('WAIT background');
      await select('Bravo');
      const usage = () => emit({ type: 'status', status: 'usage', usage: { used: 1 } });
      const working = () => emit({ type: 'tool', toolCallId: `tool-${Date.now()}`, title: 'Background tool', status: 'in_progress' });
      const box = await page.locator('.session-select', { hasText: 'Charlie' }).boundingBox();
      await page.mouse.move(box.x + 20, box.y + box.height / 2);
      await page.mouse.down();
      await usage(); await working();
      await page.waitForTimeout(150);
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelector('#breadcrumb-title').textContent === 'Charlie');
      await page.locator('.session-select', { hasText: 'Bravo' }).focus();
      await working(); await settle();
      assert.equal(await page.evaluate(() => document.activeElement?.closest('.session-item')?.dataset.sessionId), 'bbbbbbbb-0000-4000-8000-000000000002');
      await finish(); await idle();
    });

    await stage('a text drag released outside Settings keeps it open with its unsaved choices', async () => {
      await page.locator('#settings-button').click(); await page.locator('#settings-dialog[open]').waitFor();
      await page.locator('#language-select').selectOption('ja');
      await page.locator('#executable-input').scrollIntoViewIfNeeded();
      const field = await page.locator('#executable-input').boundingBox();
      const dialog = await page.locator('#settings-dialog').boundingBox();
      await page.mouse.move(field.x + field.width - 8, field.y + field.height / 2);
      await page.mouse.down();
      await page.mouse.move(dialog.x + dialog.width + 50, field.y + field.height / 2, { steps: 10 });
      await page.mouse.up();
      await settle();
      assert.equal(await page.locator('#settings-dialog').evaluate(element => element.open), true);
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'ja');
      // A click on the backdrop itself still closes it.
      await page.mouse.click(dialog.x + dialog.width + 50, dialog.y + 10);
      // Closing without saving goes back to the saved language.
      await page.waitForFunction(() => !document.querySelector('#settings-dialog').open && document.documentElement.lang === 'en');
    });

    await stage('the session menu moves with the arrow keys and Escape returns to its button', async () => {
      await page.locator('.session-item.active').hover();
      await page.locator('.session-item.active .session-more').click();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'menu-rename');
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'menu-export');
      await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'menu-delete');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#session-menu').isHidden(), true);
      assert.equal(await page.evaluate(() => document.activeElement.classList.contains('session-more') && document.activeElement.closest('.session-item').classList.contains('active')), true);
      for (const id of ['settings-dialog', 'rename-dialog', 'delete-dialog']) {
        assert.ok(await page.locator(`#${id}`).evaluate(dialog => document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent.trim()), `${id} has a name`);
      }
    });

    await stage('a streamed reply ends as a fresh render of its text, and history is sanitized once per reply', async () => {
      await select('Bravo');
      const replies = [
        // Raw HTML that spans paragraphs: rendered whole while it streams.
        'Some <b>bold\n\nmore</b> text, a `<code>` span\n\nClick: <details><summary>More</summary>\n\nHidden text\n\nStill hidden </details> after\n\nfirst-end',
        // Raw HTML closed within each block, and an <img> on its own line: rendered by blocks.
        'Press <kbd>Ctrl</kbd>+<kbd>C</kbd>\n\nline<br>two\n\n<img src="missing-chart.png" alt="Standalone chart">\n\n- item H<sub>2</sub>O\n- [link](https://example.test/a)\n\nsecond-end',
      ];
      const content = () => page.evaluate(() => [...document.querySelectorAll('.message.assistant .response-content')].map(element => {
        const copy = element.cloneNode(true);
        const images = copy.querySelectorAll('.chat-image').length;
        copy.querySelectorAll('.chat-image').forEach(figure => figure.remove());
        return { html: copy.innerHTML, images };
      }));
      for (const reply of replies) {
        await startReply('WAIT html stream');
        for (let index = 0; index < reply.length; index += 9) await emit({ type: 'text', text: reply.slice(index, index + 9) });
        await page.locator('.message').last().filter({ hasText: reply.split('\n').at(-1) }).waitFor();
        await settle();
        const streamed = (await content()).at(-1);
        await finish(); await idle();
        assert.deepEqual((await content()).at(-1), streamed, 'the end of the reply leaves it as streamed');
      }
      const streamed = await content();
      await page.evaluate(() => {
        window.__sanitized = 0;
        const sanitize = window.DOMPurify.sanitize;
        window.DOMPurify.sanitize = (...args) => { window.__sanitized++; return sanitize(...args); };
      });
      await select('Markup'); await select('Bravo');
      assert.deepEqual(await content(), streamed, 'a fresh render of the saved replies matches what was streamed');
      assert.deepEqual(streamed.map(reply => reply.images), [0, 1]);
      assert.match(await page.locator('.message.assistant details').first().textContent(), /Hidden text[\s\S]*Still hidden/);
      // Markup holds one reply and Bravo two: each is sanitized once, not once per block.
      assert.equal(await page.evaluate(() => window.__sanitized), 3);
    });

    await stage('no renderer errors', async () => assert.deepEqual(errors, []));
  } finally {
    await desktop.close().catch(() => {});
    console.log(JSON.stringify({ ...results, output: profile }));
    if (results.failed) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
