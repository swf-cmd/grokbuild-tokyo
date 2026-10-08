'use strict';

// Real renderer/IPC/protocol regression. Only the paid CLI and remote image
// transport are fixtures; local images are opened from the isolated workspace.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const base = path.join(root, 'work', 'lazy-images');
fs.mkdirSync(base, { recursive: true });
const profile = fs.mkdtempSync(path.join(base, 'run-'));
const workspace = path.join(profile, 'Workspace');
const executable = path.join(profile, process.platform === 'win32' ? 'grok.exe' : 'grok');
fs.mkdirSync(workspace); fs.mkdirSync(path.join(profile, 'data'));
fs.writeFileSync(executable, 'Offline fixture only'); fs.chmodSync(executable, 0o755);
const remote = 'https://images.example.test/preview.png';
const images = Array.from({ length: 30 }, (_, index) => {
  if (index % 2 === 0) return `${remote}?image=${index}`;
  const file = path.join(workspace, `image-${index}.png`);
  fs.copyFileSync(path.join(root, 'src', 'renderer', 'assets', 'icon.png'), file);
  return file;
});
const messages = images.map((src, index) => ({
  id: `image-${index}`, role: 'assistant', status: 'complete', createdAt: new Date().toISOString(),
  text: `Picture ${index}\n\n${'Saved paragraph with enough space between images.\n\n'.repeat(15)}`,
  images: [{ src, alt: `Picture ${index}` }], tools: [],
}));
fs.writeFileSync(path.join(profile, 'data', 'conversations.json'), JSON.stringify({
  version: 1, settings: { executable, workspace, musicEnabled: false, language: 'en' },
  sessions: [
    { id: 'pictures', title: 'Many pictures', cwd: workspace, model: 'grok-4.6', mode: 'medium', messages },
    { id: 'plain', title: 'Plain conversation', cwd: workspace, model: 'grok-4.6', mode: 'medium', messages: [{ id: 'plain-message', role: 'assistant', status: 'complete', text: 'No images here.' }] },
  ],
}));

(async () => {
  const env = { ...process.env, TOKYO_TEST_ROOT: profile };
  const sourceRoot = process.argv.includes('--packaged') ? require('../scripts/package-paths.cjs').packagedArchive(root) : root;
  if (process.argv.includes('--packaged')) env.TOKYO_UI_SOURCE_ROOT = sourceRoot;
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await _electron.launch({ args: ['--mute-audio', path.join(__dirname, 'fixtures', 'ui-app.cjs')], env });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const calls = () => desktop.evaluate(() => globalThis.__tokyoUITest.imageCalls);
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const image = index => page.locator(`[data-message-id="image-${index}"] .chat-image`);
  const scrollToImage = index => image(index).evaluate(figure => {
    const scroller = document.querySelector('#conversation-scroll');
    scroller.scrollTo({ top: scroller.scrollTop + figure.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 100, behavior: 'instant' });
  });
  try {
    await page.waitForFunction(() => !document.querySelector('#connection-button').disabled);
    await desktop.evaluate((_, { sourceRoot, failure }) => {
      const path = process.getBuiltinModule('node:path');
      const require = process.getBuiltinModule('node:module').createRequire(path.join(sourceRoot, 'package.json'));
      const { AppController } = require(path.join(sourceRoot, 'src', 'app-controller.cjs'));
      const test = globalThis.__tokyoUITest;
      test.imageCalls = []; test.failImage = failure;
      const imageURL = AppController.prototype.imageURL;
      AppController.prototype.imageURL = async function(args) {
        test.imageCalls.push({ ...args });
        if (test.failImage === args.src) { test.failImage = null; throw new Error('Fixture image temporarily unavailable'); }
        let completed;
        try {
          if (test.holdImage === args.src) {
            test.heldImageFinished = new Promise(resolve => { completed = resolve; });
            await new Promise((resolve, reject) => { test.releaseImage = resolve; test.rejectImage = reject; });
          }
          return await imageURL.call(this, args);
        } finally { completed?.(); }
      };
      const imageResponse = AppController.prototype.imageResponse;
      AppController.prototype.imageResponse = function(args) {
        // The UI fixture already serves this one public URL without the network.
        const src = args.src.startsWith('https://images.example.test/preview.png?') ? 'https://images.example.test/preview.png' : args.src;
        return imageResponse.call(this, { ...args, src });
      };
    }, { sourceRoot, failure: images.at(-1) });
    await page.evaluate(() => {
      // Keep the real observer and geometry, while retaining its callback to
      // replay a stale browser notification after a message/session disappears.
      const NativeObserver = window.IntersectionObserver;
      window.IntersectionObserver = class extends NativeObserver {
        constructor(callback, options) {
          super(callback, options); window.__imageObserverCallback = callback;
        }
      };
    });
    await page.getByRole('button', { name: 'Many pictures', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.chat-image').length === 30);
    await image(29).locator('.image-retry').waitFor({ state: 'visible' });
    await settle();
    let requested = await calls();
    assert.ok(requested.length > 0 && requested.length <= 3, `opening history prepared ${requested.length} of 30 images`);
    assert.ok(requested.every(call => images.indexOf(call.src) >= 27), 'opening history must not sweep through earlier images');
    assert.equal(await image(0).locator('img').getAttribute('src'), null);
    console.log(`PASS opening 30-image history prepares only ${requested.length} nearby image(s)`);

    await image(29).locator('.image-retry').click();
    await image(29).locator('img').evaluate(img => new Promise((resolve, reject) => {
      if (img.naturalWidth) return resolve();
      img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', reject, { once: true });
    }));
    assert.equal((await calls()).filter(call => call.src === images[29]).length, 2, 'retry must issue a fresh request');
    assert.equal(await image(29).locator('img').getAttribute('loading'), 'eager', 'prepared protocol responses must be consumed immediately');
    await image(29).locator('.image-thumbnail').click();
    await page.locator('#image-dialog[open]').waitFor();
    await page.keyboard.press('Escape');

    await scrollToImage(14);
    await page.waitForFunction(() => document.querySelector('[data-message-id="image-14"] img')?.naturalWidth > 0);
    assert.ok((await calls()).some(call => call.src === images[14]), 'scrolling must prepare a remote image');
    assert.equal(await image(0).locator('img').getAttribute('src'), null);
    await page.evaluate(() => { window.__retainedFigure = document.querySelector('[data-message-id="image-14"] .chat-image'); });
    const beforeLocale = (await calls()).length;
    await page.locator('#settings-button').click();
    await page.locator('#language-select').selectOption('ja');
    assert.equal(await image(14).evaluate(figure => figure === window.__retainedFigure), true, 'locale rerender must retain loaded figures');
    await page.keyboard.press('Escape');
    await settle();
    assert.equal((await calls()).length, beforeLocale, 'locale rerender must not prepare images again');
    console.log('PASS scrolling loads remote/local media, retry and image dialog work, locale rerender retains figures');

    const beforeRemoval = (await calls()).length;
    await image(2).evaluate(figure => {
      figure.remove();
      window.__imageObserverCallback([{ target: figure, isIntersecting: true }]);
    });
    await settle();
    assert.equal((await calls()).length, beforeRemoval, 'detached image observer callbacks must not call readImage');
    await page.evaluate(() => { window.__oldFigure = document.querySelector('[data-message-id="image-0"] .chat-image'); });
    await page.getByRole('button', { name: 'Plain conversation', exact: true }).click();
    await page.locator('.message-body').filter({ hasText: 'No images here.' }).waitFor();
    await page.evaluate(() => window.__imageObserverCallback([{ target: window.__oldFigure, isIntersecting: true }]));
    await settle();
    assert.equal((await calls()).length, beforeRemoval, 'stale observer entries from another session must not start work');

    await page.getByRole('button', { name: 'Many pictures', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.chat-image').length === 30);
    await desktop.evaluate((_, src) => { globalThis.__tokyoUITest.holdImage = src; }, images[0]);
    await scrollToImage(0);
    await page.waitForFunction(() => document.querySelector('[data-message-id="image-0"] .chat-image').getBoundingClientRect().top >= 0);
    await desktop.evaluate(() => new Promise(resolve => {
      const check = () => globalThis.__tokyoUITest.releaseImage ? resolve() : setTimeout(check, 10);
      check();
    }));
    await page.evaluate(() => { window.__inflightFigure = document.querySelector('[data-message-id="image-0"] .chat-image'); });
    await page.getByRole('button', { name: 'Plain conversation', exact: true }).click();
    await page.locator('.message-body').filter({ hasText: 'No images here.' }).waitFor();
    await desktop.evaluate(async () => {
      const test = globalThis.__tokyoUITest;
      test.releaseImage(); test.holdImage = null;
      await test.heldImageFinished;
    });
    // Allow the IPC response handlers and observer delivery after image preparation.
    await settle();
    assert.equal(await page.evaluate(() => window.__inflightFigure.querySelector('img').getAttribute('src')), null, 'late image responses must not mutate disconnected conversation nodes');
    await page.getByRole('button', { name: 'Many pictures', exact: true }).click();
    await scrollToImage(0);
    await page.waitForFunction(() => document.querySelector('[data-message-id="image-0"] img')?.naturalWidth > 0);
    assert.equal((await calls()).filter(call => call.src === images[0]).length, 2, 'returning to a conversation must obtain a fresh response after a stale request');
    console.log('PASS detached/switched observers do not load; late IPC replies are ignored and load correctly on return');

    assert.equal((await calls()).filter(call => call.src === images[8]).length, 0);
    await desktop.evaluate((_, src) => {
      const test = globalThis.__tokyoUITest;
      test.holdImage = src; test.rejectImage = null;
    }, images[8]);
    await scrollToImage(8);
    await desktop.evaluate(() => new Promise(resolve => {
      const check = () => globalThis.__tokyoUITest.rejectImage ? resolve() : setTimeout(check, 10);
      check();
    }));
    await page.evaluate(() => { window.__rejectedFigure = document.querySelector('[data-message-id="image-8"] .chat-image'); });
    await page.getByRole('button', { name: 'Plain conversation', exact: true }).click();
    await page.locator('.message-body').filter({ hasText: 'No images here.' }).waitFor();
    await desktop.evaluate(async () => {
      const test = globalThis.__tokyoUITest;
      test.rejectImage(new Error('Fixture image request failed after switching conversations')); test.holdImage = null;
      await test.heldImageFinished;
    });
    await settle();
    assert.equal(await page.evaluate(() => window.__rejectedFigure.querySelector('.image-retry').hidden), true, 'late failures must not mutate disconnected conversation nodes');
    await page.getByRole('button', { name: 'Many pictures', exact: true }).click();
    await scrollToImage(8);
    await page.waitForFunction(() => document.querySelector('[data-message-id="image-8"] img')?.naturalWidth > 0);
    assert.equal((await calls()).filter(call => call.src === images[8]).length, 2, 'returning after a stale rejection must automatically issue a fresh request');
    assert.equal(await image(8).locator('.image-retry').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS rejected IPC requests are evicted after a session switch and automatically retried on return');
  } finally {
    await desktop.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
