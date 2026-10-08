'use strict';

const fs = require('node:fs');
const { collectBlobReferences } = require('./blob-store.cjs');

// A reply streams in as many small updates. Rewriting the whole history file
// for each of them wrote gigabytes per hour once the history held long
// conversations or images. While replies are generating, their updates are
// appended here instead and the history file is rewritten only when state
// settles. After an unexpected exit, replaying this log restores each reply as
// it was last shown.
const FLUSH_DELAY = 350;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;

class TurnJournal {
  constructor(file, { onError, beforeFlush, maxBytes = MAX_JOURNAL_BYTES } = {}) {
    this.file = file;
    this.onError = onError;
    this.beforeFlush = beforeFlush;
    this.writing = null;
    this.maxBytes = maxBytes;
    this.compactAt = maxBytes;
    this.pendingBytes = 0;
    try { this.bytes = fs.statSync(file).size; } catch { this.bytes = 0; }
    // Keep live snapshots until the history file commits. A reply can stop
    // generating before its final history save succeeds.
    this.replies = new Map();
    this.pending = [];
    this.timer = null;
    this.exists = fs.existsSync(file);
    // Entries were recorded since the log last matched the running replies.
    this.dirty = false;
    // An append failed part-way. Appending after a torn line could replay the
    // same update twice, so the next write replaces the log with snapshots.
    this.broken = false;
    this.blobReferences = new Set();
    // Include all persisted events, even superseded tool payloads. A failed
    // reset must never let collection invalidate the existing recovery log.
    try {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/grok-blob:[a-f0-9]{64}/g)) this.blobReferences.add(match[0]);
    } catch (error) { this.referencesUnreadable = error.code !== 'ENOENT'; }
  }

  // Starts a reply from a complete snapshot.
  begin(sessionId, message) {
    this.replies.set(message.id, { sessionId, message });
    this.push({ sessionId, messageId: message.id, base: message });
  }

  record(sessionId, messageId, event) {
    this.push({ sessionId, messageId, event });
  }

  push(entry) {
    // Serialize now: the live objects keep changing after this point.
    const serialized = JSON.stringify(entry);
    collectBlobReferences(entry, this.blobReferences);
    this.pending.push(serialized);
    this.pendingBytes += Buffer.byteLength(serialized) + 1;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try { this.flush()?.catch(error => this.onError?.(error)); } catch (error) { this.onError?.(error); }
    }, FLUSH_DELAY);
    this.timer.unref?.();
  }

  flush() {
    this.cancel();
    if (!this.beforeFlush) return this.flushNow();
    if (this.writing) return this.writing.then(() => this.pending.length ? this.flush() : undefined);
    if (!this.pending.length && !this.broken) return Promise.resolve();
    this.writing = Promise.resolve().then(() => this.beforeFlush()).then(() => this.flushNow()).finally(() => { this.writing = null; });
    return this.writing;
  }

  flushNow() {
    if (this.broken || this.bytes + this.pendingBytes > this.compactAt) return this.resetNow([...this.replies.values()]);
    if (!this.pending.length) return;
    try { fs.appendFileSync(this.file, this.pending.join('\n') + '\n', 'utf8'); }
    catch (error) { this.broken = true; this.exists = true; throw error; }
    this.bytes += this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    this.exists = true;
  }

  // Repair keeps every tracked reply. Only after committing the history may
  // callers pass just the replies still generating and discard the others.
  reset(entries) {
    if (!this.beforeFlush) return this.resetNow(entries);
    const retained = new Set(entries.map(entry => entry.message.id));
    const removed = new Set([...this.replies.keys()].filter(id => !retained.has(id)));
    const operation = async () => {
      await this.beforeFlush();
      // New turns may start while durability waits. Only remove replies that
      // the caller actually committed; snapshots include newer live updates.
      const current = new Map(entries.map(entry => [entry.message.id, entry]));
      for (const [id, entry] of this.replies) if (!removed.has(id)) current.set(id, entry);
      this.resetNow([...current.values()]);
    };
    return this.writing ? this.writing.then(operation) : operation();
  }

  resetNow(entries) {
    this.cancel();
    if (!entries.length) {
      if (this.exists) {
        try { fs.unlinkSync(this.file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      // An interrupted snapshot replacement can leave a complete private reply
      // in the temporary file even after the final conversation is deleted.
      try { fs.unlinkSync(this.file + '.tmp'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.exists = false;
      this.bytes = 0;
      this.compactAt = this.maxBytes;
      this.blobReferences.clear();
      this.referencesUnreadable = false;
    } else if (this.dirty || this.broken || entries.length !== this.replies.size) {
      const temp = this.file + '.tmp';
      const snapshots = entries.map(({ sessionId, message }) => JSON.stringify({ sessionId, messageId: message.id, base: message }) + '\n').join('');
      fs.writeFileSync(temp, snapshots, 'utf8');
      fs.renameSync(temp, this.file);
      this.blobReferences = collectBlobReferences(entries);
      this.referencesUnreadable = false;
      this.bytes = Buffer.byteLength(snapshots);
      // A single reply can exceed the budget. Give its next deltas room before
      // compacting again; repeated tool snapshots cannot grow without bound.
      this.compactAt = Math.max(this.maxBytes, this.bytes * 2);
      this.exists = true;
    }
    this.replies = new Map(entries.map(entry => [entry.message.id, entry]));
    this.pending = [];
    this.pendingBytes = 0;
    this.dirty = false;
    this.broken = false;
  }

  cancel() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}

// Returns each logged reply as its latest snapshot plus the updates after it.
// An unreadable line can only be the tail of an interrupted write: after a
// failed append the log is replaced as a whole, never appended to again.
function readTurnJournal(file) {
  const replies = new Map();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return replies; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object' || typeof entry.sessionId !== 'string' || typeof entry.messageId !== 'string') continue;
    if (entry.base && typeof entry.base === 'object' && !Array.isArray(entry.base)) {
      replies.set(entry.messageId, { sessionId: entry.sessionId, base: entry.base, events: [] });
    } else if (entry.event && typeof entry.event === 'object' && !Array.isArray(entry.event)) {
      const reply = replies.get(entry.messageId);
      if (reply?.sessionId === entry.sessionId) reply.events.push(entry.event);
    }
  }
  return replies;
}

module.exports = { TurnJournal, readTurnJournal, FLUSH_DELAY, MAX_JOURNAL_BYTES };
