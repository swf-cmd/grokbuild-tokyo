'use strict';

// Opt-in integration test using the installed CLI and its existing login.
// Every session has its own scratch directory; no auth files are read.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { GrokAdapter } = require('../src/grok-adapter.cjs');

async function main() {
  const base = path.resolve(__dirname, '..', 'work', 'config-audit');
  await fs.mkdir(base, { recursive: true });
  const cwd = await fs.mkdtemp(path.join(base, 'live-'));
  const executable = process.env.GROK_EXECUTABLE || path.join(os.homedir(), '.grok', 'bin', 'grok.exe');
  const hashConfig = async () => fs.readFile(path.join(os.homedir(), '.grok', 'config.toml')).then(data => createHash('sha256').update(data).digest('hex'), () => null);
  const originalConfig = await hashConfig();
  const checks = [];
  const record = value => { checks.push(value); console.log(JSON.stringify(value)); };
  let adapter;
  let timer;
  const attach = enabled => {
    adapter = new GrokAdapter({ executable, cwd, subagentsEnabled: enabled });
    adapter.on('event', event => {
      if (event.type === 'permission') {
        const reject = event.options.find(option => option.kind.startsWith('reject'));
        if (reject) adapter.respondPermission({ requestId: event.requestId, optionId: reject.optionId }).catch(() => {});
        else adapter.cancel(event.sessionId).catch(() => {});
      }
    });
    return adapter;
  };
  try {
    attach(true);
    timer = setTimeout(() => adapter?.close(), 240000);
    let session = await adapter.newSession();
    const sessionId = session.sessionId;
    record({ check: 'official-default', model: session.model, mode: session.mode, modes: session.modes.map(({ id, name }) => ({ id, name })) });
    for (const option of session.modes) {
      session = await adapter.setMode({ sessionId, mode: option.id });
      assert.equal(session.mode, option.id);
      assert.equal(session.modelSelectionVerified, true);
      record({ check: 'reasoning-applied', requested: option.id, actual: session.mode });
    }
    // Use the lightest currently advertised effort for connectivity checks.
    if (session.modes.some(option => option.id === 'low')) session = await adapter.setMode({ sessionId, mode: 'low' });
    const expectedMode = session.mode;
    let tools = [];
    adapter.on('event', event => { if (event.type === 'tool' && !event.replay) tools.push(event); });
    const enabled = await adapter.prompt({ sessionId, text: 'This is a desktop configuration smoke test in an empty scratch folder. Call spawn_subagent exactly once, asking it only to reply with TOKYO_CHILD_OK without tools. Do not read or write files, run commands, or call other tools. After it finishes reply TOKYO_PARENT_OK. If spawn_subagent is absent from your available tools, reply SUBAGENT_UNAVAILABLE.' });
    record({ check: 'subagents-allowed', text: enabled.text, tools: tools.map(event => ({ title: event.title, kind: event.kind })) });
    assert(enabled.text.includes('TOKYO_PARENT_OK'), 'enabled session completed child delegation');
    assert(tools.some(event => event.kind === 'other' || /agent|delegate|task/i.test(event.title || '')), 'enabled session emitted a delegation tool event');
    await adapter.close();
    attach(false);
    session = await adapter.loadSession({ sessionId, cwd });
    assert.equal(session.mode, expectedMode, 'reasoning persisted across process restart');
    record({ check: 'reasoning-restored', mode: session.mode, verified: session.modelSelectionVerified });
    tools = [];
    adapter.on('event', event => { if (event.type === 'tool' && !event.replay) tools.push(event); });
    const disabled = await adapter.prompt({ sessionId, text: 'The client has now changed its subagent setting and restarted your engine. Inspect only the tools actually available in this turn. If spawn_subagent is available, invoke it exactly once asking it to reply TOKYO_CHILD_OK without tools. If spawn_subagent is absent, reply exactly SUBAGENT_UNAVAILABLE. Do not use any other tool, read or write files, or run commands.' });
    assert(disabled.text.includes('SUBAGENT_UNAVAILABLE'));
    assert.equal(tools.length, 0, 'disabled restored session never invoked a tool');
    record({ check: 'subagents-disabled-after-restore', reply: disabled.text, toolEvents: tools.length });
    assert.equal(await hashConfig(), originalConfig, 'official config.toml is unchanged');
    record({ check: 'official-config-unchanged', passed: true });
    await fs.writeFile(path.join(base, 'live-config-results.json'), JSON.stringify({ version: adapter.getInfo().version, checks }, null, 2));
  } finally { clearTimeout(timer); await adapter?.close(); }
}

if (process.env.GROK_CONFIG_LIVE_TEST === '1') main().catch(error => { console.error(error.message); process.exitCode = 1; });
else console.log('Set GROK_CONFIG_LIVE_TEST=1 to verify live reasoning and subagent controls.');
