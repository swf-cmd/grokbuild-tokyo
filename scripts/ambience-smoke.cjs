'use strict';

// Uses the real renderer/IPC and an isolated local profile; no model requests.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const base = path.join(root, 'work', 'ambience-qa');
fs.mkdirSync(base, { recursive: true });
const testRoot = fs.mkdtempSync(path.join(base, 'run-'));
const workspace = path.join(testRoot, 'Workspace');
const executable = path.join(testRoot, 'grok.exe');
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(testRoot, 'data'));
fs.writeFileSync(executable, 'Never executed: fake engine fixture.');
const stateFile = path.join(testRoot, 'data', 'conversations.json');
fs.writeFileSync(stateFile, JSON.stringify({ version: 1, settings: { workspace, executable, rainEnabled: true, subagentsEnabled: true }, sessions: [] }));
const readSettings = () => JSON.parse(fs.readFileSync(stateFile, 'utf8')).settings;

(async () => {
  const env = { ...process.env, TOKYO_TEST_ROOT: testRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.argv.includes('--packaged')) env.TOKYO_UI_SOURCE_ROOT = path.join(root, 'App', 'resources', 'app.asar');
  const desktop = await _electron.launch({ args: [path.join(root, 'tests', 'fixtures', 'ui-app.cjs')], env });
  const page = await desktop.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  // The sound engine still renders; silence only the QA window's physical output.
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setAudioMuted(true));
  await page.addInitScript(() => {
    let factory;
    Object.defineProperty(window, 'TokyoAmbience', {
      configurable: true,
      get: () => factory,
      set: api => { factory = { ...api, create: options => { const player = api.create(options); window.__testAmbience = player; return player; } }; },
    });
  });
  await page.reload();
  const ready = () => page.waitForFunction(() => document.querySelector('#connection-label').textContent === window.TokyoI18n.t('引擎已连接'));
  const musicState = state => page.waitForFunction(state => document.querySelector('#music-status').dataset.state === state, state, { timeout: 45000 });
  const openSettings = () => page.locator('#settings-button').click();
  const closeSettings = () => page.locator('[data-close-dialog="settings-dialog"]').click();
  const save = async () => { await page.locator('#save-settings-button').click(); await page.locator('#settings-dialog').waitFor({ state: 'hidden' }); };
  const volume = async value => {
    const slider = page.locator('#music-volume');
    await slider.focus();
    await slider.press('Home');
    for (let i = 0; i < value; i++) await slider.press('ArrowRight');
  };
  const starts = () => desktop.evaluate(() => globalThis.__tokyoUITest.calls.filter(call => call.method === 'start').length);
  try {
    await ready();
    await musicState('blocked');
    assert.equal(await page.evaluate(() => window.__testAmbience.getStatus().activeSources), 0);
    await openSettings();
    assert.equal(await page.locator('#music-input').isChecked(), true);
    assert.equal(await page.locator('#music-volume').inputValue(), '90');
    await musicState('playing');
    const audio = await page.evaluate(() => window.__testAmbience.getStatus());
    assert.equal(audio.contextState, 'running');
    assert.equal(audio.activeSources, 1);
    assert.equal(audio.durationSeconds, 96);
    assert.ok(audio.peak > 0.01 && audio.peak <= 0.8, 'audible buffer with headroom');
    assert.ok(audio.rms > 0.005 && audio.rms <= 0.13, 'non-silent music buffer');
    const initialStarts = await starts();
    console.log('PASS legacy settings migrate; music starts on a real user gesture');

    await page.locator('#rain-input').uncheck();
    assert.equal(await page.locator('#rain-layer').isHidden(), true);
    await page.locator('#music-input').uncheck();
    await musicState('paused');
    await page.waitForTimeout(750);
    const paused = await page.evaluate(() => window.__testAmbience.getStatus());
    assert.equal(paused.contextState, 'suspended');
    assert.equal(paused.activeSources, 0);
    await volume(62);
    assert.equal(await page.locator('#music-volume-value').textContent(), '62%');
    await closeSettings();
    await page.locator('#rain-layer').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#rain-layer').isHidden(), false);
    await musicState('playing');
    await openSettings();
    assert.equal(await page.locator('#music-volume').inputValue(), '90');
    assert.equal(await page.locator('#music-input').isChecked(), true);
    console.log('PASS live rain/music/volume previews; closing restores saved preferences');

    await page.locator('#rain-input').uncheck();
    await page.locator('#music-input').uncheck();
    await volume(38);
    await save();
    assert.equal(readSettings().musicEnabled, false);
    assert.equal(readSettings().musicVolume, 38);
    assert.equal(readSettings().rainEnabled, false);
    assert.equal(await starts(), initialStarts);
    await page.reload();
    await ready();
    await openSettings();
    assert.equal(await page.locator('#music-input').isChecked(), false);
    assert.equal(await page.locator('#music-volume').inputValue(), '38');
    assert.equal(await page.locator('#rain-layer').isHidden(), true);
    await musicState('paused');
    console.log('PASS saved preferences survive renderer reload without restarting Grok');

    await volume(0);
    await page.locator('#music-input').check();
    await musicState('paused');
    await save();
    assert.equal(readSettings().musicEnabled, true);
    assert.equal(readSettings().musicVolume, 0);
    await openSettings();
    await volume(25);
    await musicState('playing');
    for (let i = 0; i < 4; i++) { await page.locator('#music-input').uncheck(); await page.locator('#music-input').check(); }
    await musicState('playing');
    assert.equal(await page.evaluate(() => window.__testAmbience.getStatus().activeSources), 1);
    await page.locator('#rain-input').check();
    await save();
    console.log('PASS zero volume mutes; rapid toggles settle on playing');

    await page.locator('#prompt').fill('WAIT atmosphere settings');
    await page.locator('#send-button').click();
    await page.locator('#stop-button').waitFor({ state: 'visible' });
    await openSettings();
    await volume(18);
    await page.locator('#rain-input').uncheck();
    await save();
    assert.equal(readSettings().musicVolume, 18);
    assert.equal(await page.locator('#stop-button').isVisible(), true);
    assert.equal(await starts(), initialStarts);
    await page.locator('#stop-button').click();
    await page.locator('#stop-button').waitFor({ state: 'hidden' });
    console.log('PASS atmosphere settings save during generation without interrupting it');

    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
    await openSettings();
    await page.locator('#music-volume').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#music-volume').isVisible(), true);
    assert.equal(await page.locator('#save-settings-button').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(testRoot, 'compact-music-settings.png') });
    await page.locator('#rain-input').check();
    await save();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await page.locator('#rain-layer').evaluate(element => [getComputedStyle(element, '::before').animationName, getComputedStyle(element, '::after').animationName]);
    assert.deepEqual(reduced, ['none', 'none']);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const beforeMinimize = await page.evaluate(() => window.__testAmbience.getStatus().currentTime);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await page.waitForTimeout(1800);
    const minimized = await page.evaluate(() => window.__testAmbience.getStatus());
    assert.ok(minimized.currentTime > beforeMinimize + 1, 'audio clock advances while minimized');
    assert.equal(minimized.activeSources, 1);
    await musicState('playing');
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
    assert.deepEqual(errors, []);
    console.log('PASS compact controls remain usable; reduced-motion respected; music stays playing when minimized');
    fs.writeFileSync(path.join(testRoot, 'result.json'), JSON.stringify({ passed: true, packaged: process.argv.includes('--packaged'), errors }, null, 2));
  } catch (error) {
    console.error('Audio diagnostics:', await page.evaluate(() => ({ status: window.__testAmbience?.getStatus(), label: document.querySelector('#music-status').textContent })));
    await page.screenshot({ path: path.join(testRoot, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await desktop.close().catch(() => {});
    console.log(`QA artifacts: ${testRoot}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
