'use strict';

// Opt-in integration check; uses the installed CLI's existing login.
// Never opens auth files. The only allowed test write is in its own temp workspace.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { GrokAdapter } = require('../src/grok-adapter.cjs');

async function main() {
  const executable = process.env.GROK_EXECUTABLE || path.join(os.homedir(), '.grok', 'bin', 'grok.exe');
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-tokyo-live-'));
  const token = 'RAIN-8264';
  const statuses = {};
  let adapter;
  let timer;
  let permissionRequests = 0;
  const attach = connection => {
    connection.on('event', event => {
      if (event.type === 'status') statuses[event.status] = (statuses[event.status] || 0) + 1;
      if (event.type === 'permission') {
        permissionRequests++;
        const reject = event.options.find(option => option.kind === 'reject_once' || option.kind === 'reject_always');
        if (reject) connection.respondPermission({ requestId: event.requestId, optionId: reject.optionId }).catch(() => {});
        else connection.cancel(event.sessionId).catch(() => {});
      }
    });
  };
  try {
    adapter = new GrokAdapter({ executable, cwd });
    attach(adapter);
    timer = setTimeout(() => adapter.close(), 180000);
    const session = await adapter.newSession({ mode: 'low' });
    console.log(JSON.stringify({ check: 'handshake', version: adapter.getInfo().version, models: adapter.getInfo().models.map(model => model.id), mode: session.mode }));
    const first = await adapter.prompt({ sessionId: session.sessionId, text: `This is a client connectivity test. Remember the exact token ${token}. Do not use any tools. Reply with only that token.` });
    assert(first.text.includes(token), 'initial streamed reply contains connectivity token');
    console.log(JSON.stringify({ check: 'streaming', passed: true, characters: first.text.length }));
    await adapter.close();
    adapter = new GrokAdapter({ executable, cwd });
    attach(adapter);
    await adapter.loadSession({ sessionId: session.sessionId, cwd });
    const second = await adapter.prompt({ sessionId: session.sessionId, text: 'What exact connectivity token did I ask you to remember in the previous message? Reply only with that token, and do not use any tools.' });
    assert(second.text.includes(token), 'reloaded session retained token');
    console.log(JSON.stringify({ check: 'resume', passed: true, characters: second.text.length }));
    if (process.argv.includes('--permission')) {
      await adapter.prompt({ sessionId: session.sessionId, text: 'We are testing the client permission dialog in this dedicated temporary test directory. Use run_terminal_command once to execute: powershell -NoProfile -Command "Set-Content -LiteralPath permission-probe.txt -Value probe". If the user rejects it, do not retry, use another tool, or write anything else; just say the permission was denied.' });
      const wrote = await fs.stat(path.join(cwd, 'permission-probe.txt')).then(() => true, () => false);
      console.log(JSON.stringify({ check: 'permission', permissionRequests, blockedWrite: !wrote }));
      assert(permissionRequests > 0, 'tool permission request reached the client');
      assert(!wrote, 'denied tool did not write the test file');
    }
    console.log(JSON.stringify({ check: 'complete', passed: true, statuses }));
  } finally {
    clearTimeout(timer);
    await adapter?.close();
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

if (process.env.GROK_LIVE_TEST === '1') main().catch(error => { console.error(error.message); process.exitCode = 1; });
else console.log('Set GROK_LIVE_TEST=1 to run the optional installed-CLI integration test.');
