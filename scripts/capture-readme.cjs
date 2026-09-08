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
const motionEnabled = process.argv.includes('--motion');
const motionFps = 20;
const motionFrames = 60;
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
    // Blur and scrolling can start transitions. Do these before collecting the
    // animations so the comparison cannot mistake a settling control for rain.
    document.activeElement?.blur();
    document.querySelector('#conversation-scroll').scrollTo({ top: 0, behavior: 'instant' });
    await document.fonts.ready;
    const artwork = new Image();
    artwork.src = new URL('assets/tokyo-rain.png', location.href).href;
    await artwork.decode();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const animations = document.getAnimations();
    for (const animation of animations) {
      const timing = animation.effect.getComputedTiming();
      if (Number.isFinite(timing.endTime)) {
        animation.finish();
      } else {
        // Keep a real mid-cycle rain frame. Cancelling an infinite animation
        // loses its transform and can change its painted result.
        animation.pause();
        animation.currentTime = Number(timing.duration) * 0.42;
      }
    }
    await Promise.all(animations.map(animation => animation.ready));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function compareScreenshots(desktop, first, second, panel) {
  return desktop.evaluate(({ nativeImage }, { first, second, panel }) => {
    const firstImage = nativeImage.createFromPath(first);
    const secondImage = nativeImage.createFromPath(second);
    const size = firstImage.getSize();
    if (size.width !== 1440 || size.height !== 940 || JSON.stringify(size) !== JSON.stringify(secondImage.getSize())) throw new Error('Unexpected screenshot dimensions');
    const a = firstImage.toBitmap({ scaleFactor: 1 });
    const b = secondImage.toBitmap({ scaleFactor: 1 });
    if (a.length !== b.length || a.length !== size.width * size.height * 4) throw new Error('Unexpected bitmap dimensions');
    let changedPixels = 0, outsidePanelPixels = 0, maximumChannelDelta = 0;
    for (let index = 0; index < a.length; index += 4) {
      const delta = Math.max(Math.abs(a[index] - b[index]), Math.abs(a[index + 1] - b[index + 1]), Math.abs(a[index + 2] - b[index + 2]));
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      if (delta < 3) continue;
      const x = (index / 4) % size.width, y = Math.floor(index / 4 / size.width);
      if (x >= panel.x && x < panel.x + panel.width && y >= panel.y && y < panel.y + panel.height) changedPixels++;
      else outsidePanelPixels++;
    }
    return { changedPixels, outsidePanelPixels, maximumChannelDelta, threshold: 3 };
  }, { first, second, panel });
}

async function setRainHidden(page, hidden) {
  await page.locator('#rain-layer').evaluate(async (element, hidden) => {
    element.hidden = hidden;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, hidden);
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
  const rainOffStable = path.join(qa, `${basename}-rain-off-stable.png`);
  await page.screenshot({ path: rainOn, animations: 'allow', caret: 'hide', scale: 'css' });
  try {
    // This temporary toggle is used only for QA; the deliverable is rain-on.
    await setRainHidden(page, true);
    await page.screenshot({ path: rainOff, animations: 'allow', caret: 'hide', scale: 'css' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: rainOffStable, animations: 'allow', caret: 'hide', scale: 'css' });
  } finally {
    await setRainHidden(page, false);
  }
  const rainOffStability = await compareScreenshots(desktop, rainOff, rainOffStable, evidence.panel);
  assert.equal(rainOffStability.maximumChannelDelta, 0, 'The rain-off comparison must have no changing UI pixels');
  const pixelDiff = await compareScreenshots(desktop, rainOn, rainOff, evidence.panel);
  assert.ok(pixelDiff.changedPixels > 100, `Rain must change rendered pixels: ${JSON.stringify(pixelDiff)}`);
  assert.equal(pixelDiff.outsidePanelPixels, 0, 'Only the rain layer may change in the QA comparison');
  fs.copyFileSync(rainOn, path.join(images, `${basename}.png`));
  return { locale, view, file: `${basename}.png`, ...evidence, pixelDiff, rainOffStability };
}

async function captureMotion(desktop, page, locale, panel) {
  const basename = `welcome-${locale}`;
  const frameDirectory = path.join(output, 'frames', basename);
  fs.mkdirSync(frameDirectory, { recursive: true });
  const framePath = frame => path.join(frameDirectory, `frame-${String(frame).padStart(3, '0')}.png`);
  const rainOffStart = path.join(qa, `${basename}-motion-rain-off-start.png`);
  const rainOffEnd = path.join(qa, `${basename}-motion-rain-off-end.png`);
  await settleAndPause(page);
  try {
    await setRainHidden(page, true);
    await page.screenshot({ path: rainOffStart, animations: 'allow', caret: 'hide', scale: 'css' });
  } finally { await setRainHidden(page, false); }
  await settleAndPause(page);
  const rainAnimations = await page.evaluate(() => document.getAnimations()
    .filter(animation => ['rain-near', 'rain-far'].includes(animation.animationName))
    .map(animation => ({ name: animation.animationName, initialTime: animation.currentTime, state: animation.playState })));
  assert.deepEqual(rainAnimations.map(animation => animation.name).sort(), ['rain-far', 'rain-near']);
  assert.ok(rainAnimations.every(animation => animation.state === 'paused' && animation.initialTime > 0));
  for (let frame = 0; frame < motionFrames; frame++) {
    // Advance only the real production rain animations, in 50 ms increments.
    // No opacity, droplet geometry, or background styles are changed.
    await page.evaluate(async ({ rainAnimations, elapsedMs }) => {
      const animations = document.getAnimations();
      for (const { name, initialTime } of rainAnimations) {
        const animation = animations.find(candidate => candidate.animationName === name);
        if (!animation || animation.playState !== 'paused') throw new Error(`Rain animation is not paused: ${name}`);
        animation.currentTime = initialTime + elapsedMs;
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, { rainAnimations, elapsedMs: frame * 1000 / motionFps });
    await page.screenshot({ path: framePath(frame), animations: 'allow', caret: 'hide', scale: 'css' });
  }
  try {
    await setRainHidden(page, true);
    await page.screenshot({ path: rainOffEnd, animations: 'allow', caret: 'hide', scale: 'css' });
  } finally { await setRainHidden(page, false); }
  const rainOffStability = await compareScreenshots(desktop, rainOffStart, rainOffEnd, panel);
  assert.equal(rainOffStability.maximumChannelDelta, 0, 'Non-rain UI must remain identical throughout motion capture');
  const motionDiff = await compareScreenshots(desktop, framePath(0), framePath(motionFrames - 1), panel);
  assert.ok(motionDiff.changedPixels > 100, `Rain frames must differ: ${JSON.stringify(motionDiff)}`);
  assert.equal(motionDiff.outsidePanelPixels, 0, 'Motion must remain within the rain panel');
  fs.copyFileSync(framePath(0), path.join(qa, `${basename}-motion-first.png`));
  fs.copyFileSync(framePath(motionFrames - 1), path.join(qa, `${basename}-motion-last.png`));
  const inputPattern = path.join(frameDirectory, 'frame-%03d.png');
  const palette = path.join(frameDirectory, 'palette.png');
  const file = `${basename}.gif`;
  const gifPath = path.join(images, file);
  const ffmpegOptions = { timeout: 120000, windowsHide: true };
  // One palette for every frame and ordered dithering keep unchanged artwork
  // stable instead of introducing color or error-diffusion flicker.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(motionFps), '-i', inputPattern,
    '-vf', 'palettegen=stats_mode=full', '-frames:v', '1', palette], ffmpegOptions);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(motionFps), '-i', inputPattern,
    '-i', palette, '-filter_complex', '[0:v][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
    '-frames:v', String(motionFrames), '-loop', '0', gifPath], ffmpegOptions);
  return {
    locale, view: 'welcome', file, width: 1440, height: 940, fps: motionFps, frames: motionFrames,
    durationSeconds: motionFrames / motionFps, bytes: fs.statSync(gifPath).size,
    rainAnimations, motionDiff, rainOffStability, palette: 'shared', dither: 'bayer',
  };
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
    const ready = () => page.waitForFunction(() => window.TokyoI18n && document.querySelector('#connection-label')?.textContent === window.TokyoI18n.t('引擎已连接') && document.querySelector('#settings-button')?.disabled === false);
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
    const welcome = await captureView(desktop, page, locale, 'welcome');
    results.captures.push(welcome);
    if (motionEnabled) results.motion.push(await captureMotion(desktop, page, locale, welcome.panel));
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
  const results = { complete: false, capturedAt: new Date().toISOString(), demoTime: captureTime, platform: process.platform, workspace, captures: [], motion: [], locales: {} };
  let mapped = false;
  try {
    if (motionEnabled) execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    execFileSync('subst', ['R:', runRoot]);
    mapped = true;
    fs.mkdirSync(workspace, { recursive: true });
    for (const locale of Object.keys(copy)) await captureLocale(electron, runRoot, locale, results);
    results.complete = true;
    console.log(JSON.stringify({ complete: true, images, qa, captures: results.captures.map(({ file, pixelDiff }) => ({ file, pixelDiff })), motion: results.motion }, null, 2));
  } catch (error) {
    results.error = error.stack || String(error);
    throw error;
  } finally {
    fs.writeFileSync(path.join(qa, 'results.json'), JSON.stringify(results, null, 2));
    if (mapped) execFileSync('subst', ['R:', '/D']);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
