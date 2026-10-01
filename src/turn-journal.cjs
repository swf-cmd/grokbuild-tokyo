'use strict';

const fs = require('node:fs');

// A reply streams in as many small updates. Rewriting the whole history file
// for each of them wrote gigabytes per hour once the history held long
// conversations or images. While replies are generating, their updates are
// appended here instead and the history file is rewritten only when state
// settles. After an unexpected exit, replaying this log restores each reply as
// it was last shown.
const FLUSH_DELAY = 350;

class TurnJournal {
  // `running` returns { sessionId, message } for every reply still generating.
  constructor(file, { running, onError } = {}) {
    this.file = file;
    this.running = running || (() => []);
    this.onError = onError;
    this.pending = [];
    this.timer = null;
    this.exists = fs.existsSync(file);
    // Entries were recorded since the log last matched the running replies.
    this.dirty = false;
    // An append failed part-way. Appending after a torn line could replay the
    // same update twice, so the next write replaces the log with snapshots.
    this.broken = false;
  }

  // Starts a reply from a complete snapshot.
  begin(sessionId, message) {
    this.push({ sessionId, messageId: message.id, base: message });
  }

  record(sessionId, messageId, event) {
    this.push({ sessionId, messageId, event });
  }

  push(entry) {
    // Serialize now: the live objects keep changing after this point.
    this.pending.push(JSON.stringify(entry));
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try { this.flush(); } catch (error) { this.onError?.(error); }
    }, FLUSH_DELAY);
    this.timer.unref?.();
  }

  flush() {
    this.cancel();
    if (this.broken) return this.reset(this.running());
    if (!this.pending.length) return;
    try { fs.appendFileSync(this.file, this.pending.join('\n') + '\n', 'utf8'); }
    catch (error) { this.broken = true; this.exists = true; throw error; }
    this.pending = [];
    this.exists = true;
  }

  // Replaces the log with snapshots of the replies still generating. Callers
  // write the history file first, so it already holds every other reply.
  reset(entries) {
    this.cancel();
    if (!entries.length) {
      if (this.exists) {
        try { fs.unlinkSync(this.file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      this.exists = false;
    } else if (this.dirty || this.broken) {
      const temp = this.file + '.tmp';
      fs.writeFileSync(temp, entries.map(({ sessionId, message }) => JSON.stringify({ sessionId, messageId: message.id, base: message }) + '\n').join(''), 'utf8');
      fs.renameSync(temp, this.file);
      this.exists = true;
    }
    this.pending = [];
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

module.exports = { TurnJournal, readTurnJournal, FLUSH_DELAY };
