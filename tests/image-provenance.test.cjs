'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isReadTool, restoreMessageImages } = require('../src/media.cjs');

const block = { type: 'image', mimeType: 'image/png', data: 'cGljdHVyZQ==' };
const input = { src: 'data:image/png;base64,cGljdHVyZQ==', alt: 'Input' };
const content = [{ type: 'content', content: block }];

test('read tool classification handles current and legacy Grok records', () => {
  for (const tool of [{ kind: 'read' }, { kind: 'other', title: 'read_file' }, { title: 'Read `C:\\my image.png`' }, { rawInput: { variant: 'ReadFile' } }]) assert.equal(isReadTool(tool), true);
  for (const tool of [{ kind: 'execute', title: 'Generate image' }, { title: 'Create Read file guide' }, {}]) assert.equal(isReadTool(tool), false);
});

test('old saved read images disappear without changing user uploads or unrelated output', () => {
  const output = { src: 'https://example.test/generated.png', alt: 'Output' };
  const tools = [null, { toolCallId: 'read', title: 'read_file', content }];
  assert.deepEqual(restoreMessageImages({ role: 'assistant', images: [input, output], tools }), [output]);
  assert.deepEqual(restoreMessageImages({ role: 'assistant', tools }), []);
  assert.deepEqual(restoreMessageImages({ role: 'user', images: [input], tools }), [input]);
});

test('explicit assistant images and generated tool images survive even if a read returned the same bytes', () => {
  const tools = [{ toolCallId: 'read', kind: 'read', content }];
  const explicit = { ...input, origin: 'assistant' };
  assert.deepEqual(restoreMessageImages({ role: 'assistant', images: [explicit], tools }), [explicit]);
  tools.push({ toolCallId: 'generate', kind: 'execute', content });
  const result = restoreMessageImages({ role: 'assistant', tools });
  assert.equal(result.length, 1);
  assert.equal(result[0].src, input.src);
  assert.equal(result[0].toolCallId, 'generate');
});
