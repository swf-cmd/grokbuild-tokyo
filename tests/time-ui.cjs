'use strict';

// Exercise the actual renderer with a controlled clock and isolated fake CLI.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const base = path.join(root, 'work', 'time-qa');
fs.mkdirSync(base, { recursive: true });
const testRoot = fs.mkdtempSync(path.join(base, 'run-'));
const workspace = path.join(testRoot, 'Workspace');
const executable = path.join(testRoot, process.platform === 'win32' ? 'grok.exe' : 'grok');
fs.mkdirSync(workspace); fs.mkdirSync(path.join(testRoot, 'data'));
fs.writeFileSync(executable, 'Fixture only; never executed.');
fs.chmodSync(executable, 0o755);
const session = (id, title, time) => ({ id, title, cwd: workspace, createdAt: time, updatedAt: time, messages: [
  { id: `${id}-message`, role: 'user', text: title, createdAt: '2026-09-06T15:00:00.000Z', status: 'complete' },
] });
fs.writeFileSync(path.join(testRoot, 'data', 'conversations.json'), JSON.stringify({
  version: 1, settings: { executable, workspace, language: 'en', musicEnabled: false }, sessions: [
    session('recent', 'Recent session', '2026-09-07T14:30:00.000Z'),
    session('spring-yesterday', 'Spring yesterday', '2026-03-08T05:30:00.000Z'),
    session('spring-earlier', 'Spring earlier', '2026-03-08T04:30:00.000Z'),
    session('autumn-yesterday', 'Autumn yesterday', '2026-11-01T04:30:00.000Z'),
  ],
}));

(async () => {
  const env = { ...process.env, TOKYO_TEST_ROOT: testRoot };
  if (process.argv.includes('--packaged')) env.TOKYO_UI_SOURCE_ROOT = require('../scripts/package-paths.cjs').packagedArchive(root);
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await _electron.launch({ args: [path.join(__dirname, 'fixtures', 'ui-app.cjs')], env });
  const errors = [];
  try {
    const page = await desktop.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#connection-label')?.textContent === 'Engine connected');
    const cdp = await page.context().newCDPSession(page);
    const zone = timezoneId => cdp.send('Emulation.setTimezoneOverride', { timezoneId });
    const clock = () => page.locator('#tokyo-time').textContent();
    const focus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const groups = () => page.locator('#session-list').evaluate(list => {
      let group;
      return Object.fromEntries([...list.children].flatMap(child => {
        if (child.classList.contains('history-group-label')) { group = child.textContent; return []; }
        return [[child.querySelector('.session-title').textContent, group]];
      }));
    });
    await zone('Asia/Tokyo');
    await page.clock.install({ time: new Date('2026-09-07T14:59:58.000Z') });
    await page.clock.pauseAt(new Date('2026-09-07T14:59:59.250Z'));
    await focus();
    assert.equal(await clock(), '23:59 JST');
    assert.equal((await groups())['Recent session'], 'Today');
    await page.clock.runFor(749);
    assert.equal(await clock(), '23:59 JST');
    await page.clock.runFor(1);
    assert.equal(await clock(), '00:00 JST');
    assert.equal((await groups())['Recent session'], 'Yesterday');
    console.log('PASS clock changes exactly at the minute boundary and refreshes history at midnight');

    await page.locator('.session-select[title="Recent session"]').click();
    assert.equal(await page.locator('.message-heading time').textContent(), '00:00');
    await zone('UTC'); await focus();
    assert.equal(await clock(), '00:00 JST');
    assert.equal(await page.locator('.message-heading time').textContent(), '15:00');
    assert.equal((await groups())['Recent session'], 'Today');
    console.log('PASS Tokyo clock keeps JST while messages and history follow the system timezone');

    await page.clock.setFixedTime(new Date('2026-09-08T01:23:00.000Z'));
    await focus();
    assert.equal(await clock(), '10:23 JST');
    await page.clock.setFixedTime(new Date('2026-09-08T02:34:00.000Z'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(await clock(), '11:34 JST');
    console.log('PASS focus and visibility recovery immediately resynchronize the displayed time');

    await zone('America/New_York');
    await page.clock.setFixedTime(new Date('2026-03-09T16:00:00.000Z')); await focus();
    let actual = await groups();
    assert.equal(actual['Spring yesterday'], 'Yesterday');
    assert.equal(actual['Spring earlier'], 'Earlier');
    await page.clock.setFixedTime(new Date('2026-11-02T17:00:00.000Z')); await focus();
    actual = await groups();
    assert.equal(actual['Autumn yesterday'], 'Yesterday');
    console.log('PASS yesterday uses local calendar days across 23-hour and 25-hour DST days');
    assert.deepEqual(errors, []);
  } finally { await desktop.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
