'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const MAX_BLOB_BYTES = 20 * 1024 * 1024;
const BLOB_REFERENCE = /^grok-blob:([a-f0-9]{64})$/;

function collectBlobReferences(value, references = new Set()) {
  if (typeof value === 'string') {
    if (value.startsWith('grok-blob:') && BLOB_REFERENCE.test(value)) references.add(value);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectBlobReferences(child, references);
  }
  return references;
}

function resourceFileName(uri) {
  if (typeof uri !== 'string' || /^data:/i.test(uri) || BLOB_REFERENCE.test(uri)) return '';
  try {
    const value = /^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^[a-z]:[\\/]/i.test(uri) ? new URL(uri).pathname : uri;
    return decodeURIComponent(value.split(/[\\/]/).pop() || '').slice(0, 160);
  } catch { return ''; }
}

class BlobStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.pending = new Map();
    this.known = new Set();
    this.deleting = new Map();
    this.touched = new Map();
    this.revision = 0;
    this.collection = Promise.resolve();
  }

  store(bytes) {
    if (bytes.length > MAX_BLOB_BYTES) return null;
    const hash = createHash('sha256').update(bytes).digest('hex');
    const ref = `grok-blob:${hash}`;
    this.touched.set(hash, ++this.revision);
    if (!this.known.has(hash) && !this.pending.has(hash)) {
      const entry = { bytes, write: null };
      this.pending.set(hash, entry);
      this.writeBlob(hash, entry);
    }
    return ref;
  }

  writeBlob(hash, entry) {
    const { bytes } = entry;
    const operation = (async () => {
      // A caller can reuse content while collection is unlinking its previous
      // copy. Wait for that unlink before checking or replacing the file.
      await this.deleting.get(hash);
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const target = path.join(this.directory, hash);
      const temporary = path.join(this.directory, `.${hash}.${randomUUID()}.tmp`);
      try {
        const stat = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
        if (stat) {
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes.length) throw new Error('Invalid stored blob');
        } else {
          await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
          await fs.rename(temporary, target);
        }
        this.known.add(hash);
        this.pending.delete(hash);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    })();
    entry.write = operation;
    // Failed writes retain the source bytes. A later save retries them, so a
    // temporary full disk cannot permanently poison persistence for this app.
    operation.catch(() => { entry.write = null; });
    return operation;
  }

  fromBase64(data) {
    if (typeof data !== 'string' || data.length > Math.ceil(MAX_BLOB_BYTES / 3) * 4 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data) return null;
    return this.store(bytes);
  }

  // Transform incoming JSON synchronously so event ordering remains unchanged;
  // durability is asynchronous. Call flush before committing any reference.
  externalize(value) {
    if (typeof value === 'string') {
      const prefix = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i.exec(value);
      return prefix ? this.fromBase64(value.slice(prefix[0].length)) || 'grok-blob-unavailable:invalid-or-oversized' : value;
    }
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => this.externalize(item));
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = this.externalize(child);
    if (typeof value.mimeType === 'string') {
      const field = typeof value.blob === 'string' ? 'blob' : typeof value.data === 'string' && (value.type === 'image' || /^image\//i.test(value.mimeType) || value.encoding === 'base64') ? 'data' : null;
      const ref = field ? this.fromBase64(value[field]) : typeof value.text === 'string' && typeof value.uri === 'string' ? this.store(Buffer.from(value.text, 'utf8')) : null;
      if (ref) {
        const fileName = resourceFileName(value.uri);
        if (fileName) { result.fileName ||= fileName; result.name ||= fileName; }
        result.uri = ref;
        if (field) delete result[field]; else delete result.text;
      } else if (field || (typeof value.text === 'string' && typeof value.uri === 'string')) {
        // Unusable binary payloads must not inflate history/journals or be sent
        // back over IPC. Keep a visible diagnostic beside the resource metadata.
        if (field) delete result[field]; else delete result.text;
        result.blobError = 'Invalid or oversized embedded resource (maximum 20 MB)';
      }
    }
    return result;
  }

  resolve(reference) {
    const match = typeof reference === 'string' && BLOB_REFERENCE.exec(reference);
    if (!match) throw new Error('Invalid blob reference');
    return path.join(this.directory, match[1]);
  }

  collect(referenceProvider) {
    const operation = this.collection.catch(() => {}).then(async () => {
      const revision = this.revision;
      const references = () => typeof referenceProvider === 'function' ? referenceProvider() : referenceProvider;
      const retained = references();
      const files = await fs.readdir(this.directory, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const file of files) {
        const hash = file.name;
        if (!file.isFile()) continue;
        const temporary = /^\.([a-f0-9]{64})\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/.exec(hash);
        if (temporary) {
          if (!this.pending.has(temporary[1])) await fs.unlink(path.join(this.directory, hash)).catch(error => { if (error.code !== 'ENOENT') throw error; });
          continue;
        }
        if (!/^[a-f0-9]{64}$/.test(hash)) continue;
        const ref = `grok-blob:${hash}`;
        if (retained.has(ref) || this.pending.has(hash) || (this.touched.get(hash) || 0) > revision || references().has(ref)) continue;
        // Evict synchronously before yielding so store() retains fresh bytes
        // and queues their write behind this deletion, even for known content.
        this.known.delete(hash);
        const removal = fs.unlink(path.join(this.directory, hash)).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        this.deleting.set(hash, removal);
        try { await removal; }
        finally { this.deleting.delete(hash); }
        if ((this.touched.get(hash) || 0) <= revision) this.touched.delete(hash);
      }
    });
    this.collection = operation;
    return operation;
  }

  async flush() {
    while (this.pending.size) {
      const writes = [...this.pending].map(([hash, entry]) => entry.write || this.writeBlob(hash, entry));
      await Promise.all(writes);
    }
  }
}

module.exports = { BlobStore, BLOB_REFERENCE, MAX_BLOB_BYTES, collectBlobReferences };
