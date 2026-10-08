'use strict';
const path = require('node:path');
const { HistoryStore } = require('../../src/history-store.cjs');

// Read either a legacy fixture or the production index + per-session files.
// UI assertions inspect the durable history rather than renderer memory.
module.exports = file => new HistoryStore(path.dirname(file)).read();
