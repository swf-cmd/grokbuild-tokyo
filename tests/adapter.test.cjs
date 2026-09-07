'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { GrokAdapter } = require('../src/grok-adapter.cjs');

const fakeAgent = String.raw`
const readline = require('node:readline');
const fs = require('node:fs');
const send = message => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
const update = (sessionId, update) => send({method:'session/update',params:{sessionId,update}});
const efforts=[{id:'deep',value:'high',label:'Deep Official'},{id:'low',value:'low',label:'Low Official'}];
const models=[{modelId:'grok-test',name:'Grok Test',_meta:{reasoningEfforts:efforts}},{modelId:'grok-plain',name:'Plain',_meta:{reasoningEfforts:[]}}];
if(process.env.TEST_ALT_MODEL==='1')models.push({modelId:'grok-alternate',name:'Alternate',_meta:{reasoningEfforts:efforts}});
let model='grok-test',mode='deep',configured=false;
const modelConfigId=process.env.TEST_CUSTOM_IDS==='1'?'llm-selector':'model';
const effortConfigId=process.env.TEST_CUSTOM_IDS==='1'?'thinking-budget':'reasoning_effort';
const config=()=>[{id:modelConfigId,category:'model',type:'select',currentValue:model,options:[{group:'Models',options:models.map(m=>({value:m.modelId,name:m.name}))}]},...(model!=='grok-plain'?[{id:effortConfigId,category:'thought_level',type:'select',currentValue:mode,options:efforts.map(e=>({value:e.id,name:e.label}))}]:[])];
const session=()=>process.env.TEST_CONFIG_ONLY==='1'?{sessionId:'test-session',configOptions:config()}:({sessionId:'test-session',models:{currentModelId:model,availableModels:models},_meta:{'x.ai/sessionConfig':{options:[...models.map(m=>({id:m.modelId,category:'model',label:m.name,selected:m.modelId===model})),...(model!=='grok-plain'?efforts.map(e=>({id:e.id,category:'mode',label:e.label,selected:e.id===mode})):[])]}}});
let pendingPrompt;
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); const p=m.params||{};
 fs.appendFileSync('requests.ndjson',line+'\n');
 if(m.method==='initialize') send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},_meta:{agentVersion:'test'}}});
 else if(m.method==='session/new') send({id:m.id,result:session()});
 else if(m.method==='session/load') {if(process.env.TEST_FAIL_READBACK==='1'&&configured){send({id:m.id,error:{code:-32000,message:'Readback failed'}});return;}update(p.sessionId,{sessionUpdate:'user_message_chunk',content:{type:'text',text:'earlier prompt'}});update(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'earlier reply'}});send({id:m.id,result:session()});}
 else if(m.method==='session/set_config_option') {
   if(process.env.TEST_MODERN!=='1') send({id:m.id,error:{code:-32601,message:'Method not found'}});
   else {if(p.configId===modelConfigId){model=p.value;mode=model==='grok-test'?'deep':model==='grok-alternate'?'low':'';}else if(p.configId===effortConfigId)mode=p.value;else {send({id:m.id,error:{code:-32602,message:'Unknown config option'}});return;}configured=true;send({id:m.id,result:{configOptions:config()}});}
 }
 else if(m.method==='session/set_model') {
   if(process.env.TEST_NOOP!=='1'){model=p.modelId;mode=model==='grok-test'?(efforts.find(e=>e.value===p._meta?.reasoningEffort)?.id||'deep'):'';}
   configured=true;send({id:m.id,result:{_meta:{model:{Ok:model}}}});
 }
 else if(m.method==='session/set_mode') send({id:m.id,result:{}});
 else if(m.method==='session/prompt') {
   pendingPrompt=m;
   const text=p.prompt[0].text;
   if(text==='permission') {send({id:'allow-42',method:'session/request_permission',params:{sessionId:p.sessionId,toolCall:{toolCallId:'tool-1',title:'Write a file'},options:[{optionId:'yes',name:'Allow once',kind:'allow_once'},{optionId:'no',name:'Reject',kind:'reject_once'}]}});}
   else if(text==='hang') {}
   else if(text==='crash') process.exit(7);
   else {
     update(p.sessionId,{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Thinking'}});
     update(p.sessionId,{sessionUpdate:'tool_call',toolCallId:'read-1',title:'Read directory',kind:'read',status:'in_progress'});
     update(p.sessionId,{sessionUpdate:'tool_call_update',toolCallId:'read-1',status:'completed',rawOutput:'OK'});
     const line=Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'东京'}}}})+'\n');
     const split=line.indexOf(Buffer.from('东'))+1;
     process.stdout.write(line.subarray(0,split));
     setImmediate(()=>{process.stdout.write(line.subarray(split));update(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'雨夜'}});send({id:m.id,result:{stopReason:'end_turn'}});});
   }
 } else if(m.method==='session/cancel'&&pendingPrompt) {send({id:pendingPrompt.id,result:{stopReason:'cancelled'}});pendingPrompt=null;}
 else if(m.id==='allow-42'&&m.result?.outcome?.outcome==='selected') {update(pendingPrompt.params.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:m.result.outcome.optionId==='yes'?'Approved':'Denied'}});send({id:pendingPrompt.id,result:{stopReason:'end_turn'}});pendingPrompt=null;}
});
`;

async function fixture(t, settings = {}) {
  const base = path.resolve(__dirname, '..', 'work', 'adapter-tests');
  await fs.mkdir(base, { recursive: true });
  const cwd = await fs.mkdtemp(path.join(base, 'run-'));
  await fs.writeFile(path.join(cwd, 'agent'), fakeAgent);
  const adapter = new GrokAdapter({ executable: process.execPath, cwd, subagentsEnabled: settings.subagentsEnabled, spawnProcess: (executable, args, options) => {
    assert.deepEqual(args, ['agent', '--no-leader', 'stdio']);
    assert.equal(options.env.GROK_SUBAGENTS, settings.subagentsEnabled === false ? '0' : '1');
    options.env.TEST_MODERN = settings.modern ? '1' : '0';
    options.env.TEST_NOOP = settings.noop ? '1' : '0';
    options.env.TEST_FAIL_READBACK = settings.failReadback ? '1' : '0';
    options.env.TEST_CONFIG_ONLY = settings.configOnly ? '1' : '0';
    options.env.TEST_CUSTOM_IDS = settings.customIds ? '1' : '0';
    options.env.TEST_ALT_MODEL = settings.alternateModel ? '1' : '0';
    return spawn(executable, ['agent'], options);
  } });
  t.after(async () => { await adapter.close(); assert(path.resolve(cwd).startsWith(base + path.sep)); await fs.rm(cwd, { recursive: true, force: true }); });
  const events = [];
  adapter.on('event', event => events.push(event));
  return { adapter, events, cwd, requests: async () => (await fs.readFile(path.join(cwd, 'requests.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('streams split UTF-8 ACP text and correlates tool updates', async t => {
  const { adapter, events } = await fixture(t);
  const [first, second] = await Promise.all([adapter.start(), adapter.start()]);
  assert.equal(first.version, 'test');
  assert.equal(second.connected, true);
  const session = await adapter.newSession();
  const result = await adapter.prompt({ sessionId: session.sessionId, text: 'hello' });
  assert.equal(result.text, '东京雨夜');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(events.filter(event => event.type === 'tool').length, 2);
  assert.equal(events.find(event => event.type === 'thought').text, 'Thinking');
  assert.deepEqual(adapter.getInfo().models.map(model => model.id), ['grok-test', 'grok-plain']);
  await adapter.setMode({ sessionId: session.sessionId, mode: 'low' });
  assert.equal(adapter.sessions.get(session.sessionId).mode, 'low');
  await assert.rejects(adapter.setMode({ sessionId: session.sessionId, mode: 'made-up' }), { code: 'INVALID_MODE' });
});

test('permission options are explicit, validated, and resolved once', async t => {
  const { adapter } = await fixture(t);
  const { sessionId } = await adapter.newSession();
  const permission = new Promise(resolve => adapter.on('event', event => { if (event.type === 'permission') resolve(event); }));
  const prompt = adapter.prompt({ sessionId, text: 'permission' });
  const request = await permission;
  assert.equal(request.requestId, 'allow-42');
  await assert.rejects(adapter.respondPermission({ requestId: request.requestId, optionId: 'unknown' }), { code: 'INVALID_PERMISSION' });
  await adapter.respondPermission({ requestId: request.requestId, optionId: 'no' });
  assert.equal((await prompt).text, 'Denied');
  await assert.rejects(adapter.respondPermission({ requestId: request.requestId, optionId: 'yes' }), { code: 'PERMISSION_EXPIRED' });
});

test('cancels a pending permission and the running prompt', async t => {
  const { adapter, events } = await fixture(t);
  const { sessionId } = await adapter.newSession();
  const permission = new Promise(resolve => adapter.on('event', event => { if (event.type === 'permission') resolve(event); }));
  const prompt = adapter.prompt({ sessionId, text: 'permission' });
  await permission;
  await adapter.cancel(sessionId);
  const result = await prompt;
  assert.equal(result.cancelled, true);
  assert.equal(adapter.permissions.size, 0);
  assert(events.some(event => event.status === 'permission_resolved' && event.cancelled));
});

test('load labels replay events and allows session continuation', async t => {
  const { adapter, events } = await fixture(t);
  const session = await adapter.loadSession({ sessionId: 'test-session' });
  assert.equal(session.sessionId, 'test-session');
  const replay = events.filter(event => event.type === 'text');
  assert.equal(replay.length, 2);
  assert(replay.every(event => event.replay));
  assert.equal(replay[0].role, 'user');
  assert.equal((await adapter.prompt({ sessionId: session.sessionId, text: 'continue' })).text, '东京雨夜');
});

test('process exit rejects an in-flight request and permits reconnect', async t => {
  const { adapter } = await fixture(t);
  const { sessionId } = await adapter.newSession();
  await assert.rejects(adapter.prompt({ sessionId, text: 'crash' }), { code: 'PROCESS_EXIT' });
  assert.equal(adapter.getInfo().connected, false);
  assert.equal((await adapter.prompt({ sessionId, text: 'continue' })).text, '东京雨夜');
});

test('close settles a running prompt and prevents accidental restart', async t => {
  const { adapter } = await fixture(t);
  const { sessionId } = await adapter.newSession();
  const started = new Promise(resolve => adapter.on('event', event => { if (event.status === 'busy') resolve(); }));
  const prompt = adapter.prompt({ sessionId, text: 'hang' });
  await started;
  await assert.rejects(adapter.prompt({ sessionId, text: 'duplicate' }), { code: 'SESSION_BUSY' });
  await adapter.close();
  assert.equal((await prompt).cancelled, true);
  await assert.rejects(adapter.start(), { code: 'CLOSED' });
});

test('legacy reasoning uses official metadata wire values and verifies engine state', async t => {
  const { adapter, requests } = await fixture(t, { subagentsEnabled: false });
  const session = await adapter.newSession({ mode: 'low' });
  assert.equal(session.mode, 'low');
  assert.equal(session.modelSelectionVerified, true);
  assert.equal(session.modes[0].name, 'Deep Official');
  await adapter.setMode({ sessionId: session.sessionId, mode: 'deep' });
  const sent = await requests();
  assert.equal(sent.filter(m => m.method === 'session/set_config_option').length, 1, 'unsupported API is probed only once');
  assert.equal(sent.some(m => m.method === 'session/set_mode'), false, 'session mode is not reasoning effort');
  assert.deepEqual(sent.filter(m => m.method === 'session/set_model').map(m => m.params._meta), [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }]);
  assert.equal(sent.filter(m => m.method === 'session/load').length, 2);
  assert.equal(sent.find(m => m.method === 'session/new').params._meta, undefined, 'official permission defaults are not overwritten');
});

test('a no-op success cannot masquerade as an applied reasoning change', async t => {
  const { adapter } = await fixture(t, { noop: true });
  const { sessionId } = await adapter.newSession();
  await assert.rejects(adapter.setMode({ sessionId, mode: 'low' }), { code: 'CONFIG_NOT_APPLIED' });
  assert.equal(adapter.getSession(sessionId).mode, 'deep');
  assert.equal(adapter.getSession(sessionId).modelSelectionVerified, true, 'actual unchanged selection is known');
});

test('failed readback invalidates local state instead of claiming success', async t => {
  const { adapter } = await fixture(t, { failReadback: true });
  const { sessionId } = await adapter.newSession();
  await assert.rejects(adapter.setMode({ sessionId, mode: 'low' }), /Readback failed/);
  assert.equal(adapter.getSession(sessionId).modelSelectionVerified, false);
  assert.equal(adapter.getSession(sessionId).loaded, false);
});

test('modern config API uses menu IDs and authoritative returned selections', async t => {
  const { adapter, requests } = await fixture(t, { modern: true });
  const { sessionId } = await adapter.newSession({ mode: 'low' });
  await adapter.setMode({ sessionId, mode: 'deep' });
  const current = await adapter.setModel({ sessionId, model: 'grok-plain' });
  assert.equal(current.model, 'grok-plain');
  assert.equal(current.mode, '');
  assert.deepEqual(current.modes, []);
  assert.deepEqual(adapter.getInfo().modes, []);
  await assert.rejects(adapter.setMode({ sessionId, mode: 'low' }), { code: 'INVALID_MODE' });
  const sent = await requests();
  assert.equal(sent.some(m => m.method === 'session/set_model'), false);
  assert.equal(sent.find(m => m.method === 'session/set_config_option' && m.params.value === 'deep').params.configId, 'reasoning_effort');
});

test('force restore replaces stale selection and official session mode does not overwrite effort', async t => {
  const { adapter } = await fixture(t);
  const { sessionId, cwd } = await adapter.newSession();
  adapter.sessions.get(sessionId).mode = 'low';
  const actual = await adapter.loadSession({ sessionId, cwd, force: true });
  assert.equal(actual.mode, 'deep');
  adapter._sessionUpdate({ sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' } });
  assert.equal(adapter.getSession(sessionId).mode, 'deep');
});

test('modern config-only sessions discover grouped menus and use the advertised option IDs', async t => {
  const { adapter, requests } = await fixture(t, { modern: true, configOnly: true, customIds: true });
  const session = await adapter.newSession();
  assert.deepEqual(session.models.map(model => [model.id, model.name]), [['grok-test', 'Grok Test'], ['grok-plain', 'Plain']]);
  assert.equal(session.model, 'grok-test');
  assert.equal(session.mode, 'deep');
  assert.equal(session.modelSelectionVerified, true);
  assert.equal((await adapter.setMode({ sessionId: session.sessionId, mode: 'low' })).mode, 'low');
  assert.equal((await adapter.setModel({ sessionId: session.sessionId, model: 'grok-plain' })).model, 'grok-plain');
  assert.deepEqual((await requests()).filter(message => message.method === 'session/set_config_option').map(message => message.params.configId), ['thinking-budget', 'llm-selector']);
});

test('creating with a model and effort applies effort after the model changes its default', async t => {
  const { adapter, requests } = await fixture(t, { modern: true, alternateModel: true });
  const session = await adapter.newSession({ model: 'grok-alternate', mode: 'deep' });
  assert.equal(session.model, 'grok-alternate');
  assert.equal(session.mode, 'deep');
  assert.deepEqual((await requests()).filter(message => message.method === 'session/set_config_option').map(message => message.params.value), ['grok-alternate', 'deep']);
});

test('a complete config update removes unavailable reasoning choices despite older model metadata', async t => {
  const { adapter } = await fixture(t);
  const { sessionId } = await adapter.newSession();
  adapter._sessionUpdate({ sessionId, update: { sessionUpdate: 'config_option_update', configOptions: [
    { id: 'model', type: 'select', currentValue: 'grok-test', options: [{ value: 'grok-test', name: 'Grok Test' }] },
  ] } });
  assert.deepEqual(adapter.getSession(sessionId).modes, []);
  assert.equal(adapter.getSession(sessionId).mode, '');
  assert.deepEqual(adapter.getInfo().modes, []);
  assert.equal(adapter.getInfo().currentModeId, '');
  await assert.rejects(adapter.setMode({ sessionId, mode: 'deep' }), { code: 'INVALID_MODE' });
});

test('model validation uses each session menu instead of the most recently loaded session', async t => {
  const { adapter, cwd } = await fixture(t);
  await adapter.newSession();
  adapter._rememberSession({ configOptions: [
    { id: 'model', type: 'select', currentValue: 'other-model', options: [{ value: 'other-model', name: 'Other' }] },
  ] }, 'other-session', cwd);
  await assert.rejects(adapter.setModel({ sessionId: 'test-session', model: 'other-model' }), { code: 'INVALID_MODEL' });
  assert.equal((await adapter.setModel({ sessionId: 'test-session', model: 'grok-plain' })).model, 'grok-plain');
});

test('enabling subagents overrides an inherited disabled environment', async t => {
  const previous = process.env.GROK_SUBAGENTS;
  process.env.GROK_SUBAGENTS = '0';
  try {
    const { adapter } = await fixture(t, { subagentsEnabled: true });
    assert.equal((await adapter.start()).subagentsEnabled, true);
  } finally {
    if (previous === undefined) delete process.env.GROK_SUBAGENTS;
    else process.env.GROK_SUBAGENTS = previous;
  }
});

test('reconnecting rediscovers configuration API support', async t => {
  const settings = {};
  const { adapter, requests } = await fixture(t, settings);
  const { sessionId } = await adapter.newSession({ mode: 'low' });
  await assert.rejects(adapter.prompt({ sessionId, text: 'crash' }), { code: 'PROCESS_EXIT' });
  settings.modern = true;
  await adapter.loadSession({ sessionId });
  assert.equal((await adapter.setMode({ sessionId, mode: 'low' })).mode, 'low');
  assert.equal((await requests()).filter(message => message.method === 'session/set_config_option').length, 2);
});

test('model metadata distinguishes undiscovered reasoning choices from an explicitly empty catalog', () => {
  const adapter = new GrokAdapter();
  const efforts = [{ id: 'deep', value: 'high', label: 'Deep' }];
  adapter._updateModels({ availableModels: [
    { modelId: 'unknown' },
    { modelId: 'null-catalog', _meta: { reasoningEfforts: null } },
    { modelId: 'plain', _meta: { reasoningEfforts: [] } },
    { modelId: 'thinking', _meta: { reasoningEffort: 'high', reasoningEfforts: efforts } },
  ] });
  const models = adapter.getInfo().models;
  assert.equal(Object.hasOwn(models[0], 'reasoningEfforts'), false);
  assert.equal(Object.hasOwn(models[1], 'reasoningEfforts'), false);
  assert.deepEqual(models[2].reasoningEfforts, []);
  assert.deepEqual(models[3].reasoningEfforts, efforts);
  assert.equal(models[3].reasoningEffort, 'high');

  const session = adapter._rememberSession({ configOptions: [
    { id: 'model', type: 'select', currentValue: 'unknown', options: [{ value: 'unknown', name: 'Unknown catalog' }] },
    { id: 'reasoning_effort', type: 'select', currentValue: 'deep', options: [{ value: 'deep', name: 'Deep' }] },
  ] }, 'discovered-session', adapter.cwd);
  assert.equal(session.mode, 'deep');
  assert.deepEqual(session.modes.map(mode => mode.id), ['deep']);
  assert.equal(session.modelSelectionVerified, true);
  assert.equal(Object.hasOwn(session.models[0], 'reasoningEfforts'), false, 'session choices do not imply a model-wide catalog');
});
