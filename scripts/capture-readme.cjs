'use strict';

// Capture the actual Windows renderer, IPC and controller with the offline CLI
// fixture. Review work/readme-capture before copying its images into docs/images.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'work', 'readme-capture');
const images = path.join(output, 'images');
const qa = path.join(output, 'qa');
const captureTime = '2026-09-07T14:42:00.000Z';
const workspace = 'R:\\Workspace';
const copy = {
  en: {
    title: 'Build a focus timer',
    history: ['Explore the project', 'Polish the interface'],
    prompt: 'Build a small focus timer with a 25-minute session, a 5-minute break, and keyboard shortcuts. Keep it simple and easy to use.',
    answer: [
      'A small, focused starting point: two modes, one timer, and a clear next action.',
      '### The essentials',
      '- **Focus:** 25 minutes of uninterrupted work.\n- **Break:** 5 minutes to step away.\n- **Controls:** start, pause, and reset. Space toggles the timer; R resets it.',
      '```js\nconst durations = { focus: 25 * 60, break: 5 * 60 };\n\nfunction formatTime(seconds) {\n  const minutes = Math.floor(seconds / 60);\n  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;\n}\n```',
      'Keep the countdown large, the controls close, and the current mode visible. The timer should also work entirely offline.',
    ].join('\n\n'),
  },
  'zh-CN': {
    title: '做一个专注计时器',
    history: ['读懂这个项目', '打磨界面细节'],
    prompt: '做一个简洁的专注计时器：专注 25 分钟，休息 5 分钟，支持键盘快捷键。保持简单、好用。',
    answer: [
      '先从一个小而完整的版本开始：两种模式、一个计时器，以及清晰的下一步操作。',
      '### 核心功能',
      '- **专注：** 25 分钟，不被打断地完成一件事。\n- **休息：** 5 分钟，起身活动一下。\n- **操作：** 开始、暂停与重置。空格键切换计时，R 键重置。',
      '```js\nconst durations = { focus: 25 * 60, break: 5 * 60 };\n\nfunction formatTime(seconds) {\n  const minutes = Math.floor(seconds / 60);\n  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;\n}\n```',
      '让倒计时足够醒目，操作按钮触手可及，当前模式始终可见。计时器也应支持完全离线运行。',
    ].join('\n\n'),
  },
};

function seedProfile(runRoot, locale) {
  const testRoot = path.join(runRoot, locale);
  const executable = path.join(testRoot, 'grok.exe');
  for (const directory of ['data', 'default-grok']) fs.mkdirSync(path.join(testRoot, directory), { recursive: true });
  fs.writeFileSync(executable, 'Offline UI fixture only. This file must never be executed.');
  fs.writeFileSync(path.join(testRoot, 'default-grok', 'auth.json'), JSON.stringify({
    'https://auth.x.ai': { key: 'fixture-not-a-real-credential', auth_mode: 'oidc', email: 'tokyo@example.test' },
  }));
  const text = copy[locale];
  const session = (id, title, date, messages) => ({
    id, accountId: 'local', title, titleIsDefault: false, cwd: workspace,
    createdAt: date, updatedAt: date, model: 'grok-4', mode: '', messages,
  });
  const sessions = [
    session('readme-focus-timer', text.title, captureTime, [
      { id: 'demo-user', role: 'user', text: text.prompt, status: 'complete', createdAt: '2026-09-07T14:40:00.000Z' },
      { id: 'demo-assistant', role: 'assistant', text: text.answer, status: 'complete', createdAt: '2026-09-07T14:41:00.000Z' },
    ]),
    ...text.history.map((title, index) => session(`readme-history-${index}`, title, '2026-09-06T14:00:00.000Z', [])),
  ];
  fs.writeFileSync(path.join(testRoot, 'data', 'conversations.json'), JSON.stringify({
    version: 2,
    settings: { executable, workspace, language: locale, rainEnabled: true, musicEnabled: false, musicVolume: 90, subagentsEnabled: true },
    accounts: [{ id: 'local', name: '本机 Grok 账户', nameIsDefault: true }],
    activeAccountId: 'local', sessions,
  }, null, 2));
  return { testRoot, sessions };
}

async function settleAndPause(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const artwork = new Image();
    artwork.src = new URL('assets/tokyo-rain.png', location.href).href;
    await artwork.decode();
    const animations = document.getAnimations();
    for (const animation of animations) {
      const timing = animation.effect.getComputedTiming();
      animation.pause();
      // Keep a real mid-cycle rain frame. Cancelling infinite animations for a
      // screenshot loses their transform and can change their painted result.
      animation.currentTime = Number.isFinite(timing.endTime)
        ? timing.endTime : Number(timing.duration) * 0.42;
    }
    await Promise.all(animations.map(animation => animation.ready));
    document.activeElement?.blur();
    document.querySelector('#conversation-scroll').scrollTop = 0;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function captureView(desktop, page, locale, view) {
  await page.mouse.move(10, 10);
  await settleAndPause(page);
  assert.equal(await page.locator('#rain-layer').isVisible(), true, 'The rain preference must be enabled');
  const evidence = await page.locator('#rain-layer').evaluate(element => {
    const layer = getComputedStyle(element);
    const readPseudo = pseudo => {
      const style = getComputedStyle(element, pseudo);
      return { animationName: style.animationName, backgroundImage: style.backgroundImage, opacity: style.opacity, transform: style.transform };
    };
    const panel = element.getBoundingClientRect();
    return {
      hidden: element.hidden, opacity: layer.opacity, maskImage: layer.maskImage,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      before: readPseudo('::before'), after: readPseudo('::after'),
      panel: { x: panel.x, y: panel.y, width: panel.width, height: panel.height },
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      overflow: document.documentElement.scrollWidth > innerWidth,
      contentOverflow: document.querySelector('#conversation-scroll').scrollWidth > document.querySelector('#conversation-scroll').clientWidth,
      animations: document.getAnimations().map(animation => ({ name: animation.animationName || '', state: animation.playState, currentTime: animation.currentTime })),
    };
  });
  assert.deepEqual(evidence.viewport, { width: 1440, height: 940, devicePixelRatio: 1 });
  assert.equal(evidence.overflow, false);
  assert.equal(evidence.contentOverflow, false);
  assert.equal(evidence.reducedMotion, false);
  assert.equal(evidence.before.animationName, 'rain-near');
  assert.equal(evidence.after.animationName, 'rain-far');
  for (const pseudo of [evidence.before, evidence.after]) {
    assert.match(pseudo.backgroundImage, /radial-gradient/);
    assert.notEqual(pseudo.transform, 'none');
  }
  for (const name of ['rain-near', 'rain-far']) assert.ok(evidence.animations.some(animation => animation.name === name && animation.state === 'paused' && animation.currentTime > 0));
  const basename = `${view}-${locale}`;
  const rainOn = path.join(qa, `${basename}-rain-on.png`);
  const rainOff = path.join(qa, `${basename}-rain-off.png`);
  await page.screenshot({ path: rainOn, animations: 'allow', caret: 'hide', scale: 'css' });
  try {
    // This temporary toggle is used only for QA; the deliverable is rain-on.
    await page.locator('#rain-layer').evaluate(element => { element.hidden = true; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: rainOff, animations: 'allow', caret: 'hide', scale: 'css' });
  } finally {
    await page.locator('#rain-layer').evaluate(element => { element.hidden = false; });
  }
  const pixelDiff = await desktop.evaluate(({ nativeImage }, { rainOn, rainOff, panel }) => {
    const onImage = nativeImage.createFromPath(rainOn);
    const offImage = nativeImage.createFromPath(rainOff);
    const size = onImage.getSize();
    if (size.width !== 1440 || size.height !== 940 || JSON.stringify(size) !== JSON.stringify(offImage.getSize())) throw new Error('Unexpected screenshot dimensions');
    const on = onImage.toBitmap({ scaleFactor: 1 });
    const off = offImage.toBitmap({ scaleFactor: 1 });
    if (on.length !== off.length || on.length !== size.width * size.height * 4) throw new Error('Unexpected bitmap dimensions');
    let changedPixels = 0, outsidePanelPixels = 0, maximumChannelDelta = 0;
    for (let index = 0; index < on.length; index += 4) {
      const delta = Math.max(Math.abs(on[index] - off[index]), Math.abs(on[index + 1] - off[index + 1]), Math.abs(on[index + 2] - off[index + 2]));
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      if (delta < 3) continue;
      const x = (index / 4) % size.width, y = Math.floor(index / 4 / size.width);
      if (x >= panel.x && x < panel.x + panel.width && y >= panel.y && y < panel.y + panel.height) changedPixels++;
      else outsidePanelPixels++;
    }
    return { changedPixels, outsidePanelPixels, maximumChannelDelta, threshold: 3 };
  }, { rainOn, rainOff, panel: evidence.panel });
  assert.ok(pixelDiff.changedPixels > 100, `Rain must visibly change the screenshot: ${JSON.stringify(pixelDiff)}`);
  assert.equal(pixelDiff.outsidePanelPixels, 0, 'Only the rain layer may change in the QA comparison');
  fs.copyFileSync(rainOn, path.join(images, `${basename}.png`));
  return { locale, view, file: `${basename}.png`, ...evidence, pixelDiff };
}

async function captureLocale(electron, runRoot, locale, results) {
  const { testRoot, sessions } = seedProfile(runRoot, locale);
  const env = { ...process.env, TOKYO_TEST_ROOT: testRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TOKYO_UI_SOURCE_ROOT;
  const desktop = await electron.launch({ args: ['--force-device-scale-factor=1', path.join(root, 'tests', 'fixtures', 'ui-app.cjs')], env });
  const errors = [];
  try {
    const page = await desktop.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(15000);
    const ready = () => page.waitForFunction(() => document.querySelector('#connection-label')?.textContent === window.TokyoI18n.t('引擎已连接') && !document.querySelector('#settings-button').disabled);
    await ready();
    await desktop.evaluate(({ BrowserWindow }, sessions) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(1440, 940);
      window.webContents.setAudioMuted(true);
      const fixture = globalThis.__tokyoUITest;
      for (const session of sessions) {
        const record = { sessionId: session.id, cwd: session.cwd, model: 'grok-4', mode: '', models: fixture.adapter.info.models, modes: [], loaded: true, modelSelectionVerified: true };
        fixture.records.set(session.id, structuredClone(record));
        fixture.adapter.sessions.set(session.id, structuredClone(record));
      }
      Object.assign(fixture.adapter.info, { currentModelId: 'grok-4', currentModeId: '', modes: [] });
    }, sessions);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' });
    await page.clock.setFixedTime(new Date(captureTime));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.reload();
    await ready();
    assert.equal(await page.locator('#model-select').inputValue(), 'grok-4');
    assert.equal(await page.locator('#tokyo-time').textContent(), '23:42 JST');
    await page.locator('#welcome').waitFor({ state: 'visible' });
    results.captures.push(await captureView(desktop, page, locale, 'welcome'));
    await page.locator('.session-select').filter({ hasText: copy[locale].title }).click();
    await page.waitForFunction(() => document.querySelectorAll('#messages .message').length === 2 && !document.querySelector('#model-select').disabled);
    assert.equal(await page.locator('#model-select').inputValue(), 'grok-4');
    results.captures.push(await captureView(desktop, page, locale, 'app'));
    const activity = await desktop.evaluate(() => ({
      prompts: globalThis.__tokyoUITest.calls.filter(call => call.method === 'prompt').length,
      logins: globalThis.__tokyoUITest.calls.filter(call => call.method === 'login').length,
      external: globalThis.__tokyoUITest.external,
    }));
    assert.deepEqual(activity, { prompts: 0, logins: 0, external: [] });
    assert.deepEqual(errors, []);
    results.locales[locale] = { pageErrors: errors, fixtureActivity: activity };
  } finally { await desktop.close(); }
}

async function main() {
  assert.equal(process.platform, 'win32', 'README captures describe Windows; run this script on a Windows host');
  assert.equal(fs.existsSync('R:\\'), false, 'R: is already in use; refusing to replace an existing drive');
  const { _electron: electron } = require('playwright');
  for (const directory of [images, qa]) fs.mkdirSync(directory, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(output, 'fixture-'));
  const results = { complete: false, capturedAt: new Date().toISOString(), demoTime: captureTime, platform: process.platform, workspace, captures: [], locales: {} };
  let mapped = false;
  try {
    execFileSync('subst', ['R:', runRoot]);
    mapped = true;
    fs.mkdirSync(workspace, { recursive: true });
    for (const locale of Object.keys(copy)) await captureLocale(electron, runRoot, locale, results);
    results.complete = true;
    console.log(JSON.stringify({ complete: true, images, qa, captures: results.captures.map(({ file, pixelDiff }) => ({ file, pixelDiff })) }, null, 2));
  } catch (error) {
    results.error = error.stack || String(error);
    throw error;
  } finally {
    fs.writeFileSync(path.join(qa, 'results.json'), JSON.stringify(results, null, 2));
    if (mapped) execFileSync('subst', ['R:', '/D']);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
