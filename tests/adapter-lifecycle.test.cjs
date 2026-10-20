'use strict';
// How the adapter behaves around the edges of a CLI's life: starting and
// restoring before a prompt is sent, exiting, failing pipes, listeners that
// throw, and stopping the tools a CLI started.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { GrokAdapter } = require('../src/grok-adapter.cjs');

// A CLI process in memory. `reply(message, child)` answers each request; the
// child's stdout, stderr, exit and close can also be driven by the test.
function syntheticChild(reply) {
  const child = new EventEmitter();
  Object.assign(child, { pid: null, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.send = message => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  child.exit = (code = 0) => { child.exitCode = code; child.emit('exit', code, null); };
  child.kill = () => { if (child.exitCode === null) { child.exit(137); child.stdout.end(); child.stderr.end(); child.emit('close', 137, null); } return true; };
  readline.createInterface({ input: child.stdin }).on('line', line => reply(JSON.parse(line), child));
  return child;
}

function standardReply(message, child, onPrompt) {
  if (message.method === 'initialize') child.send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (message.method === 'session/new') child.send({ id: message.id, result: { sessionId: 'session', configOptions: [] } });
  else if (message.method === 'session/prompt') onPrompt?.(message, child);
}

function synthetic(t, onPrompt) {
  const children = [];
  const adapter = new GrokAdapter({ cwd: __dirname, spawnProcess: () => {
    const child = syntheticChild((message, owner) => standardReply(message, owner, onPrompt));
    children.push(child);
    return child;
  } });
  t.after(() => adapter.close().catch(() => {}));
  const events = [];
  adapter.on('event', event => events.push(event));
  return { adapter, children, events };
}

// An adapter whose writes are captured and answered by the test.
function wired() {
  const adapter = new GrokAdapter();
  const writes = [];
  adapter.ready = true;
  adapter._validateCwd = async cwd => cwd;
  adapter.process = { stdin: { destroyed: false, writableEnded: false, write: line => writes.push(JSON.parse(line)) } };
  const events = [];
  adapter.on('event', event => events.push(event));
  const answer = (method, result) => {
    const request = writes.filter(item => item.method === method).at(-1);
    adapter._message({ jsonrpc: '2.0', id: request.id, ...(result instanceof Error ? { error: { code: result.code, message: result.message } } : { result }) });
  };
  return { adapter, writes, events, answer };
}

test('Stop while the engine starts or the conversation is restored keeps the prompt from being sent', async () => {
  const { adapter, writes, events } = wired();
  adapter.ready = false;
  let release;
  const starting = new Promise(resolve => { release = resolve; });
  adapter.start = async () => { await starting; adapter.ready = true; };
  adapter.sessions.set('session', { sessionId: 'session', loaded: true });
  const prompt = adapter.prompt({ sessionId: 'session', text: 'delete the build folder' });
  await new Promise(setImmediate);
  await assert.rejects(adapter.prompt({ sessionId: 'session', text: 'again' }), { code: 'SESSION_BUSY' });
  assert.deepEqual(await adapter.cancel('session'), { cancelled: true });
  release();
  assert.equal((await prompt).cancelled, true);
  assert.equal(writes.some(item => item.method === 'session/prompt'), false);
  assert.ok(events.some(event => event.status === 'cancelled' && event.sessionId === 'session'));
  assert.equal(adapter.preparing.size, 0);
  assert.equal(adapter.active.size, 0);
});

test('the last answer a CLI writes as it exits is still delivered', async t => {
  const { adapter, events } = synthetic(t, (message, child) => {
    child.send({ method: 'session/update', params: { sessionId: 'session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });
    // The exit is reported before the pipe delivers the final line, which has no newline.
    child.exit(0);
    setImmediate(() => {
      child.stdout.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } }));
      child.stderr.end('shutting down');
      setImmediate(() => child.emit('close', 0, null));
    });
  });
  const { sessionId } = await adapter.newSession();
  const result = await adapter.prompt({ sessionId, text: 'finish up' });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.text, 'done');
  const disconnected = events.find(event => event.status === 'disconnected');
  assert.ok(disconnected, 'the exit still ends the connection');
  assert.match(disconnected.message, /shutting down/, 'with the end of stderr as the reason');
  assert.equal(adapter.ready, false);
  assert.equal(adapter.process, null);
});

test('a listener that throws is reported without stopping the CLI or other conversations', async t => {
  const answered = [];
  const { adapter, events } = synthetic(t, (message, child) => {
    answered.push(message);
    child.send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } } });
    child.send({ id: message.id, result: { stopReason: 'end_turn' } });
  });
  const { sessionId } = await adapter.newSession();
  const errors = t.mock.method(console, 'error', () => {});
  adapter.on('event', event => { if (event.type === 'text') throw new Error('Render frame was disposed'); });
  assert.equal((await adapter.prompt({ sessionId, text: 'hi' })).text, 'hello');
  assert.equal(events.some(event => event.status === 'disconnected'), false);
  assert.equal(adapter.ready, true);
  assert.ok(errors.mock.callCount() >= 1);
});

test('a read error on an output pipe ends the connection instead of throwing', async t => {
  const { adapter, children, events } = synthetic(t);
  await adapter.start();
  for (const stream of ['stdout', 'stderr']) assert.ok(children[0][stream].listenerCount('error') >= 1, `${stream} has an error handler`);
  children[0].stdout.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
  await new Promise(setImmediate);
  assert.equal(adapter.ready, false);
  assert.ok(events.some(event => event.status === 'disconnected' && /ECONNRESET/.test(event.message)));
});

test('a CLI without session restore keeps the conversation usable after a selection it cannot confirm', async () => {
  const { adapter, writes, answer } = wired();
  adapter.info.capabilities = { loadSession: false };
  adapter.sessions.set('session', { sessionId: 'session', loaded: true, model: 'grok', mode: 'low', models: [{ id: 'grok' }], modes: [{ id: 'low', value: 'low' }, { id: 'high', value: 'high' }] });
  const change = adapter.setMode({ sessionId: 'session', mode: 'high' });
  await new Promise(setImmediate);
  answer('session/set_config_option', Object.assign(new Error('Method not found'), { code: -32601 }));
  await new Promise(setImmediate);
  // Grok 1.0's set_model acknowledges without returning the selection.
  answer('session/set_model', { _meta: { model: { Ok: 'grok' } } });
  await assert.rejects(change, { code: 'SESSION_LOAD_UNSUPPORTED' });
  const session = adapter.getSession('session');
  assert.equal(session.loaded, true);
  assert.equal(session.modelSelectionVerified, false);
  const prompt = adapter.prompt({ sessionId: 'session', text: 'still works' });
  await new Promise(setImmediate);
  assert.ok(writes.some(item => item.method === 'session/prompt'), 'the next message is sent');
  answer('session/prompt', { stopReason: 'end_turn' });
  assert.equal((await prompt).stopReason, 'end_turn');
});

test('a restore that timed out keeps its late replay out of the next reply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { adapter, writes, events, answer } = wired();
  adapter.info.capabilities = { loadSession: true };
  const chunk = text => adapter._message({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
  const load = adapter.loadSession({ sessionId: 's' });
  await new Promise(setImmediate);
  chunk('OLD REPLY PART 1 ');
  t.mock.timers.tick(3 * 60000);
  await assert.rejects(load, { code: 'TIMEOUT' });
  chunk('OLD REPLY PART 2 ');
  assert.ok(events.filter(event => event.type === 'text').every(event => event.replay), 'still marked as replay');
  await assert.rejects(adapter.prompt({ sessionId: 's', text: 'new question' }), { code: 'SESSION_BUSY' });
  // The CLI finishes the old restore.
  answer('session/load', { sessionId: 's', configOptions: [] });
  await new Promise(setImmediate);
  assert.equal(adapter.loading.size, 0);
  // The conversation is restored again before the new message, as after any failed restore.
  const prompt = adapter.prompt({ sessionId: 's', text: 'new question' });
  await new Promise(setImmediate);
  assert.equal(writes.filter(item => item.method === 'session/load').length, 2);
  chunk('OLD REPLY, REPLAYED AGAIN ');
  answer('session/load', { sessionId: 's', configOptions: [] });
  await new Promise(setImmediate);
  chunk('fresh answer');
  answer('session/prompt', { stopReason: 'end_turn' });
  assert.equal((await prompt).text, 'fresh answer');
});

test('POSIX shutdown lets the CLI stop the tools it started in their own sessions', { skip: process.platform === 'win32' }, async t => {
  const base = path.resolve(__dirname, '..', 'work', 'adapter-lifecycle-tests');
  await fs.mkdir(base, { recursive: true });
  const cwd = await fs.mkdtemp(path.join(base, 'run-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  // Like Grok's bash tool: the command runs in a new session (setsid), outside
  // the CLI's process group, and the CLI's SIGTERM handler ends it.
  await fs.writeFile(path.join(cwd, 'agent.js'), String.raw`
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
fs.writeFileSync('tool.pid', String(tool.pid));
process.on('SIGTERM', () => { try { process.kill(tool.pid, 'SIGKILL'); } catch {} process.exit(0); });
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + '\n');
});
process.stdin.on('end', () => {});
`);
  const adapter = new GrokAdapter({ executable: process.execPath, cwd, spawnProcess: (executable, args, options) => spawn(executable, ['agent.js'], options) });
  await adapter.start();
  const pid = Number(await fs.readFile(path.join(cwd, 'tool.pid'), 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  // The CLI ignores the end of its input, as a CLI busy with a tool would.
  await adapter.close();
  const alive = async () => {
    try { process.kill(pid, 0); } catch { return false; }
    return !(process.platform === 'linux' && /\) Z /.test(await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ') Z ')));
  };
  const deadline = Date.now() + 2000;
  while (await alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await alive(), false, 'the tool must not outlive the CLI');
});

test('an exited CLI is released at once, even while its pipes are still draining', async t => {
  const { adapter, children, events } = synthetic(t);
  await adapter.start();
  const child = children[0];
  child.exit(0);
  // macOS reports the pipes closed a little later than the exit.
  assert.equal(adapter.process, null, 'nothing is left to stop on shutdown');
  await assert.rejects(adapter._request('session/new', {}, 0), { code: 'NOT_CONNECTED' }, 'nothing more is written to it');
  await adapter.close();
  assert.equal(events.some(event => event.status === 'disconnected'), false, 'the connection ends when its output does');
  child.stdout.end();
  child.emit('close', 0, null);
  assert.ok(events.some(event => event.status === 'disconnected'));
  assert.equal(adapter.ready, false);
});
