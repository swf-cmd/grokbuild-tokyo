'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');

let worker;
let sequence = 0;
const pending = new Map();
function writeInWorker(payload) {
  if (!worker) {
    worker = new Worker(path.join(__dirname, 'history-writer.cjs'));
    worker.on('message', ({ id, error }) => {
      const request = pending.get(id);
      pending.delete(id);
      if (error) request?.reject(Object.assign(new Error(error.message), { code: error.code }));
      else request?.resolve();
      if (!pending.size) worker?.unref();
    });
    const owned = worker;
    worker.on('exit', code => {
      if (worker !== owned) return;
      for (const request of pending.values()) request.reject(new Error(`History worker exited (${code})`));
      pending.clear(); worker = null;
    });
    worker.on('error', error => {
      for (const request of pending.values()) request.reject(error);
      pending.clear(); worker = null;
    });
    worker.unref();
  }
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.ref();
    try { worker.postMessage({ id, ...payload }); }
    catch (error) { pending.delete(id); if (!pending.size) worker.unref(); reject(error); }
  });
}

function sessionMetadata(session) {
  const { messages, contentFile, ...metadata } = session;
  return { ...metadata, messageCount: messages?.length || 0, lastMessageStatus: messages?.at(-1)?.status || null };
}

class HistoryStore {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'conversations.json');
    this.files = new Map();
    this.legacy = false;
    this.savedIndex = null;
    this.queue = Promise.resolve();
    this.write = writeInWorker;
    /** @type {((messages: any[]) => any[]) | undefined} */
    this.transformMessages = undefined;
    /** @type {(() => Promise<void>) | undefined} */
    this.beforeWrite = undefined;
    /** @type {Set<string>} */
    this.unsettled = new Set();
  }
  read() {
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (data.version === 3) {
      if (!Array.isArray(data.sessions)) throw new Error('Invalid history index');
      for (const session of data.sessions) {
        if (!/^[a-f0-9-]{36}\.json$/.test(session.contentFile)) throw new Error('Invalid conversation file');
        const file = session.contentFile;
        const messages = JSON.parse(fs.readFileSync(path.join(this.directory, 'sessions', file), 'utf8')).messages;
        if (!Array.isArray(messages)) throw new Error('Invalid conversation messages');
        this.files.set(session.id, file);
        delete session.contentFile;
        delete session.messageCount;
        delete session.lastMessageStatus;
        session.messages = messages;
      }
    } else this.legacy = true;
    return data;
  }
  save({ settings, accounts, activeAccountId, sessions }, dirtyIds = []) {
    const dirty = new Set(dirtyIds);
    const metadata = sessions.map(sessionMetadata);
    // Only changed message arrays cross the worker boundary. Metadata changes
    // such as switching models never clone or stringify historical messages.
    const content = sessions.filter(session => dirty.has(session.id) || !this.files.has(session.id))
      .map(session => ({ id: session.id, messages: structuredClone(this.transformMessages ? this.transformMessages(session.messages) : session.messages) }));
    for (const item of content) for (const message of item.messages) if (this.unsettled.has(message.id)) message.status = 'working';
    const header = structuredClone({ settings, accounts, activeAccountId });
    const operation = this.queue.catch(() => {}).then(async () => {
      const files = new Map(this.files);
      const updates = content.map(({ id, messages }) => {
        const file = `${randomUUID()}.json`; files.set(id, file); return { file, messages };
      });
      const index = { version: 3, ...header, sessions: metadata.map(session => ({ ...session, contentFile: files.get(session.id) })) };
      const encoded = JSON.stringify(index); // Small index only; no message content.
      if (!updates.length && encoded === this.savedIndex) return;
      await this.beforeWrite?.();
      await this.write({ directory: this.directory, index, updates, legacy: this.legacy });
      this.files = new Map(index.sessions.map(session => [session.id, session.contentFile]));
      this.legacy = false;
      this.savedIndex = encoded;
    });
    this.queue = operation;
    return operation;
  }
}
module.exports = { HistoryStore, sessionMetadata };
