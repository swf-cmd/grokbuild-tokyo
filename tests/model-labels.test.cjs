'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { labelModel, servedModelFromUsage } = require('../src/model-labels.cjs');
const { GrokAdapter } = require('../src/grok-adapter.cjs');

test('verified legacy label identifies Grok 4.3 without changing its selectable ID', () => {
  const model = labelModel({ modelId: 'grok-4', name: 'grok-4', contextTokens: 200000 });
  assert.equal(model.name, 'Grok 4.3 (grok-4)');
  assert.equal(model.id, 'grok-4');
  assert.equal(model.modelId, 'grok-4');
  assert.equal(model.contextTokens, 200000);
  assert.equal(model.resolvedModelId, 'grok-4.3');
  assert.equal(model.modelIdentitySource, 'verified-alias');
  assert.equal(labelModel(model).name, model.name);
});

test('explicit CLI names and other model IDs never inherit the legacy alias', () => {
  for (const model of [
    { id: 'grok-4', name: 'Grok 4.7' },
    { id: 'grok-4', name: 'Company model' },
    { id: 'grok-4.6', name: 'Grok 4.6' },
    { id: 'grok-4.3', name: 'Grok 4.3' },
    { id: 'my-grok-4', name: 'grok-4' },
  ]) {
    const result = labelModel(model);
    assert.equal(result.name, model.name);
    assert.equal(result.resolvedModelId, undefined);
  }
});

test('session config labels cannot overwrite the corrected legacy catalog label', () => {
  const adapter = new GrokAdapter();
  const availableModels = [{ modelId: 'grok-4', name: 'grok-4', _meta: { totalContextTokens: 200000 } }];
  adapter._updateModels({ currentModelId: 'grok-4', availableModels });
  assert.equal(adapter.getInfo().models[0].name, 'Grok 4.3 (grok-4)');
  const legacy = adapter._rememberSession({
    models: { currentModelId: 'grok-4', availableModels },
    _meta: { 'x.ai/sessionConfig': { options: [{ id: 'grok-4', category: 'model', label: 'grok-4', selected: true }] } },
  }, 'legacy', process.cwd());
  assert.equal(legacy.model, 'grok-4');
  assert.equal(legacy.models[0].name, 'Grok 4.3 (grok-4)');
  const modern = adapter._rememberSession({ configOptions: [{
    id: 'model', type: 'select', currentValue: 'grok-4', options: [{ value: 'grok-4', name: 'Grok 4' }],
  }] }, 'modern', process.cwd());
  assert.equal(modern.model, 'grok-4');
  assert.equal(modern.models[0].name, 'Grok 4.3 (grok-4)');
});

test('model selection sends the original CLI ID and rejects an invented replacement', async () => {
  const adapter = new GrokAdapter();
  adapter.sessions.set('test', { loaded: true, model: 'other', models: [labelModel({ id: 'grok-4', name: 'Grok 4' })] });
  adapter.start = async () => adapter.getInfo();
  adapter.loadSession = async () => adapter.getSession('test');
  const requests = [];
  adapter._setSelection = async (...args) => { requests.push(args); return {}; };
  await adapter.setModel({ sessionId: 'test', model: 'grok-4' });
  assert.deepEqual(requests, [['test', 'model', 'grok-4']]);
  await assert.rejects(adapter.setModel({ sessionId: 'test', model: 'grok-4.3' }), { code: 'INVALID_MODEL' });
});

test('a config choice without a label retains an explicit name from the CLI catalog', () => {
  const adapter = new GrokAdapter();
  const session = adapter._rememberSession({
    models: { currentModelId: 'grok-4', availableModels: [{ modelId: 'grok-4', name: 'Grok 4.7' }] },
    configOptions: [{ id: 'model', type: 'select', currentValue: 'grok-4', options: [{ value: 'grok-4' }] }],
  }, 'test', process.cwd());
  assert.equal(session.models[0].name, 'Grok 4.7');
  assert.equal(session.models[0].resolvedModelId, undefined);
});

test('live turn usage supersedes the verified fallback and survives catalog/config refresh', () => {
  const adapter = new GrokAdapter();
  const availableModels = [{ modelId: 'grok-4', name: 'grok-4' }];
  adapter._rememberSession({ models: { currentModelId: 'grok-4', availableModels } }, 'test', process.cwd());
  const events = [];
  adapter.on('event', event => events.push(event));
  adapter._message({ method: '_x.ai/session/update', params: { sessionId: 'test', update: {
    sessionUpdate: 'turn_completed', usage: { modelUsage: { 'grok-4.7': { modelCalls: 1 } } },
  } } });
  assert.equal(adapter.getSession('test').models[0].name, 'Grok 4.7 (grok-4)');
  assert.equal(adapter.getSession('test').model, 'grok-4');
  assert.equal(adapter.getInfo().models[0].modelIdentitySource, 'usage');
  assert.equal(events[0].status, 'model_changed');
  adapter._updateModels({ availableModels });
  const refreshed = adapter._rememberSession({ configOptions: [{
    id: 'model', type: 'select', currentValue: 'grok-4', options: [{ value: 'grok-4', name: 'grok-4' }],
  }] }, 'test', process.cwd());
  assert.equal(refreshed.models[0].name, 'Grok 4.7 (grok-4)');
});

test('ambiguous usage and replay cannot overwrite model identity', () => {
  assert.equal(servedModelFromUsage({ modelUsage: { 'grok-4.3': {}, 'grok-4.6': {} } }), undefined);
  assert.equal(servedModelFromUsage({ modelUsage: {} }), undefined);
  const adapter = new GrokAdapter();
  adapter._rememberSession({ models: { currentModelId: 'grok-4', availableModels: [{ modelId: 'grok-4', name: 'grok-4' }] } }, 'test', process.cwd());
  adapter.loading.add('test');
  adapter._sessionUpdate({ sessionId: 'test', update: { sessionUpdate: 'turn_completed', usage: { modelUsage: { 'grok-4.1': {} } } } });
  assert.equal(adapter.getSession('test').models[0].name, 'Grok 4.3 (grok-4)');
  adapter.loading.delete('test');
  adapter._sessionUpdate({ sessionId: 'test', update: { sessionUpdate: 'turn_completed', usage: { modelUsage: { 'grok-4.1': {}, 'grok-4.6': {} } } } });
  assert.equal(adapter.getSession('test').models[0].name, 'Grok 4.3 (grok-4)');
});

test('usage reporting the original model ID overrides the Grok 4.3 fallback', () => {
  const adapter = new GrokAdapter();
  const result = { models: { currentModelId: 'grok-4', availableModels: [{ modelId: 'grok-4', name: 'grok-4' }] } };
  adapter._rememberSession(result, 'test', process.cwd());
  adapter._rememberServedModel('test', { modelUsage: { 'grok-4': { modelCalls: 1 } } });
  let model = adapter.getSession('test').models[0];
  assert.equal(model.name, 'Grok 4 (grok-4)');
  assert.equal(model.resolvedModelId, 'grok-4');
  assert.equal(model.modelIdentitySource, 'usage');
  model = adapter._rememberSession(result, 'test', process.cwd()).models[0];
  assert.equal(model.name, 'Grok 4 (grok-4)');
  assert.equal(model.id, 'grok-4');
});

test('new and restored sessions use their own observed route', () => {
  const adapter = new GrokAdapter();
  const result = { models: { currentModelId: 'grok-4', availableModels: [{ modelId: 'grok-4', name: 'grok-4' }] } };
  adapter._rememberSession(result, 'first', process.cwd());
  adapter._rememberServedModel('first', { modelUsage: { 'grok-4.7': { modelCalls: 1 } } });
  // A new config-only session uses a catalog copied from the last session, but
  // that session's observed identity must not become evidence for the new one.
  const config = { configOptions: [{ id: 'model', type: 'select', currentValue: 'grok-4', options: [{ value: 'grok-4' }] }] };
  assert.equal(adapter._rememberSession(config, 'second', process.cwd()).models[0].name, 'Grok 4.3 (grok-4)');
  adapter._rememberServedModel('second', { modelUsage: { 'grok-4': { modelCalls: 1 } } });
  assert.equal(adapter._rememberSession(result, 'first', process.cwd()).models[0].name, 'Grok 4.7 (grok-4)');
  assert.equal(adapter._rememberSession(result, 'second', process.cwd()).models[0].name, 'Grok 4 (grok-4)');
  assert.equal(adapter._rememberSession(result, 'third', process.cwd()).models[0].name, 'Grok 4.3 (grok-4)');
});
