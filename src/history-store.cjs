'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { collectBlobReferences } = require('./blob-store.cjs');

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
    this.references = new Map();
    this.queuedReferences = new Set();
    this.legacyReferences = new Set();
    this.sessionIds = new Set();
    this.accountIds = new Set();
    this.backupRetirementAllowed = false;
    this.recoveryReferences = null;
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
        this.references.set(session.id, collectBlobReferences(messages));
        delete session.contentFile;
        delete session.messageCount;
        delete session.lastMessageStatus;
        session.messages = messages;
      }
    } else {
      this.legacy = true;
      this.legacyReferences = collectBlobReferences(data);
    }
    this.sessionIds = new Set((data.sessions || []).map(session => session.id));
    this.accountIds = new Set((data.accounts || []).map(account => account.id));
    return data;
  }
  blobReferences() {
    const refs = new Set(this.legacyReferences);
    for (const group of [...this.references.values(), ...this.queuedReferences]) for (const ref of group) refs.add(ref);
    return refs;
  }
  async cleanupLegacyBackup() {
    if (!this.backupRetirementAllowed) return;
    await fs.promises.unlink(path.join(this.directory, 'conversations.v2-backup.json')).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    this.legacyReferences.clear();
  }
  // Explicit corruption-recovery snapshots are separate from the temporary v2
  // migration backup. Keep their blobs usable without rescanning them per save.
  readRecoveryReferences() {
    if (!this.recoveryReferences) this.recoveryReferences = (async () => {
      const refs = new Set();
      const files = await fs.promises.readdir(this.directory, { withFileTypes: true });
      const read = async file => {
        const text = await fs.promises.readFile(file, 'utf8');
        for (const match of text.matchAll(/grok-blob:[a-f0-9]{64}/g)) refs.add(match[0]);
      };
      for (const entry of files) {
        if (!/^conversations\.(?:json|journal)\.unreadable-\d+(?:\.sessions)?$/.test(entry.name)) continue;
        const file = path.join(this.directory, entry.name);
        if (entry.isFile()) await read(file);
        else if (entry.isDirectory() && entry.name.endsWith('.sessions')) {
          for (const child of await fs.promises.readdir(file, { withFileTypes: true })) {
            if (child.isFile() && /^[a-f0-9-]{36}\.json(?:\.tmp)?$/.test(child.name)) await read(path.join(file, child.name));
          }
        }
      }
      return refs;
    })().catch(error => { this.recoveryReferences = null; throw error; });
    return this.recoveryReferences;
  }
  save({ settings, accounts, activeAccountId, sessions }, dirtyIds = []) {
    const dirty = new Set(dirtyIds);
    const metadata = sessions.map(sessionMetadata);
    // Only changed message arrays cross the worker boundary. Metadata changes
    // such as switching models never clone or stringify historical messages.
    const content = sessions.filter(session => dirty.has(session.id) || !this.files.has(session.id))
      .map(session => ({ id: session.id, messages: structuredClone(this.transformMessages ? this.transformMessages(session.messages) : session.messages) }));
    for (const item of content) for (const message of item.messages) if (this.unsettled.has(message.id)) message.status = 'working';
    const contentReferences = new Map(content.map(item => [item.id, collectBlobReferences(item.messages)]));
    const queuedReferences = new Set();
    for (const session of metadata) for (const ref of contentReferences.get(session.id) || this.references.get(session.id) || []) queuedReferences.add(ref);
    this.queuedReferences.add(queuedReferences);
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
      const sessionIds = new Set(metadata.map(session => session.id));
      const accountIds = new Set(header.accounts.map(account => account.id));
      if ([...this.sessionIds].some(id => !sessionIds.has(id)) || [...this.accountIds].some(id => !accountIds.has(id))) this.backupRetirementAllowed = true;
      this.sessionIds = sessionIds;
      this.accountIds = accountIds;
      this.references = new Map(metadata.map(session => [session.id, contentReferences.get(session.id) || this.references.get(session.id) || new Set()]));
      this.files = new Map(index.sessions.map(session => [session.id, session.contentFile]));
      this.legacy = false;
      this.savedIndex = encoded;
    }).finally(() => this.queuedReferences.delete(queuedReferences));
    this.queue = operation;
    return operation;
  }
}
module.exports = { HistoryStore, sessionMetadata };
