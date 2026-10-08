const { createI18n, languages, normalizeLanguage } = require('./i18n.js');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { GrokAdapter } = require('./grok-adapter.cjs');
const { findGrokExecutable, isExecutable } = require('./platform.cjs');
const { AccountManager, ACCOUNT_ID } = require('./account-manager.cjs');
const { imagesFromTools, restoreMessageImages, resolveImageResponse, findSessionImageDirectory } = require('./media.cjs');
const { MAX_ATTACHMENTS, MAX_TOTAL_BYTES, stageAttachments, attachmentsFromTools, restoreMessageAttachments, attachmentsFromText, resolveAttachment, cleanupAttachments } = require('./attachments.cjs');
const { ControllerAccounts } = require('./controller-accounts.cjs');
const { ControllerQuota, QUOTA_AFTER_TURN_DELAY, QUOTA_AFTER_TURN_INTERVAL } = require('./controller-quota.cjs');
const { TurnJournal, readTurnJournal } = require('./turn-journal.cjs');
const { pathToFileURL } = require('node:url');
const { BlobStore, BLOB_REFERENCE } = require('./blob-store.cjs');
const { HistoryStore, sessionMetadata } = require('./history-store.cjs');
const TEXT_SCAN_INTERVAL = 500;
const textScanTimes = new WeakMap();
const MEDIA_VERSION = 1;

// Conversations run side by side in one Grok process. Bound the number of
// simultaneous turns so a burst of tasks cannot exhaust tools or the account.
const MAX_CONCURRENT_TURNS = 4;

function isPathType(value, type) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return false;
  try { return fs.statSync(value)[type](); } catch { return false; }
}

const STOP_NOTICES = {
  max_tokens: '回复达到输出长度上限，可发送消息让 Grok 继续。',
  max_turn_requests: '本轮已达到请求次数上限，可发送消息让 Grok 继续。',
  refusal: 'Grok 拒绝了这次请求。',
};

// Engine updates that change the reply they belong to.
const REPLY_UPDATE_TYPES = new Set(['text', 'thought', 'tool', 'image', 'attachment', 'response-boundary', 'error']);

// Applies one streamed engine update to its reply. Live updates and crash
// recovery share this, so a recovered reply matches what was on screen.
// `emit` receives media found along the way; the returned update is the one
// forwarded to the window.
function applyReplyUpdate(message, event, sessionId, emit = () => {}, scanText = true) {
  if (event.type === 'status' && event.status === 'plan') {
    // ACP plans replace the previous plan, including an explicitly empty one.
    const entries = (Array.isArray(event.entries) ? event.entries : []).filter(entry => typeof entry?.content === 'string').map(entry => ({
      content: entry.content,
      priority: ['high', 'medium', 'low'].includes(entry.priority) ? entry.priority : 'medium',
      status: ['pending', 'in_progress', 'completed'].includes(entry.status) ? entry.status : 'pending',
    }));
    message.plan = entries;
    event = { ...event, entries };
  }
  const addAttachment = attachment => {
    message.attachments ||= [];
    if (!attachment?.id || !attachment.src) return;
    const index = message.attachments.findIndex(item => item.id === attachment.id || (item.src === attachment.src && item.name === attachment.name));
    if (index >= 0) {
      // Explicit assistant output remains output even when a tool previously
      // returned the same resource. Keep that provenance across restarts.
      if (attachment.origin === 'assistant') message.attachments[index] = attachment;
      return;
    }
    message.attachments.push(attachment);
    if (event.type !== 'attachment') emit({ type: 'attachment', sessionId, attachment });
  };
  if (event.type === 'response-boundary') {
    const lastSegment = message.responseSegments?.at(-1);
    if (lastSegment) lastSegment.kind = 'commentary';
  }
  if (event.type === 'text') {
    const text = event.text || '';
    message.responseSegments ||= [];
    if (text) {
      const lastSegment = message.responseSegments.at(-1);
      if (!lastSegment || event.segmentStart) {
        if (lastSegment) lastSegment.kind = 'commentary';
        message.responseSegments.push({ text, kind: 'response' });
      } else lastSegment.text += text;
      message.text += `${event.segmentStart && message.text ? '\n\n' : ''}${text}`;
    }
  }
  if (event.type === 'scan-attachments' || (event.type === 'text' && scanText && Date.now() - (textScanTimes.get(message) ?? -Infinity) >= TEXT_SCAN_INTERVAL)) {
    textScanTimes.set(message, Date.now());
    for (const attachment of attachmentsFromText(message.text)) addAttachment({ ...attachment, origin: 'assistant' });
  }
  if (event.type === 'attachment') {
    event = { ...event, attachment: { ...event.attachment, origin: 'assistant' } };
    addAttachment(event.attachment);
  }
  if (event.type === 'thought') message.thought += event.text || '';
  if (event.type === 'image' && event.image?.src) {
    event = { ...event, image: { ...event.image, origin: 'assistant' } };
    message.images ||= [];
    const index = message.images.findIndex(image => image.src === event.image.src);
    if (index < 0) message.images.push(event.image); else message.images[index] = event.image;
  }
  if (event.type === 'tool') {
    const existing = message.tools.find(t => t.toolCallId === event.toolCallId);
    if (existing) Object.assign(existing, event); else message.tools.push({ ...event });
    for (const attachment of attachmentsFromTools([existing || event])) addAttachment(attachment);
    const images = imagesFromTools([existing || event]);
    for (const image of images) {
      message.images ||= [];
      if (!message.images.some(item => item.src === image.src)) {
        message.images.push(image);
        emit({ type: 'image', sessionId, image });
      }
    }
  }
  if (event.type === 'error') message.error = event.message;
  return event;
}

// A reply the app was generating when it last exited is rebuilt from the
// journal. Only an unfinished reply is replaced: once a reply ends, the
// history file holds its final state and older journal entries no longer apply.
function recoverReply(message, sessionId, logged) {
  if (!logged || logged.sessionId !== sessionId || message?.role !== 'assistant' || message.status !== 'working') return message;
  try {
    const reply = logged.base;
    for (const event of logged.events) applyReplyUpdate(reply, event, sessionId, undefined, false);
    delete reply.mediaVersion;
    if (reply.id === message.id && reply.role === 'assistant' && typeof reply.text === 'string') return reply;
  } catch {}
  return message;
}

class AppController extends EventEmitter {
  constructor({ root, home, Adapter = GrokAdapter, Accounts = AccountManager, quotaFetch = null, nativeImage = null }) {
    super();
    this.root = root;
    this.nativeImage = nativeImage;
    this.Adapter = Adapter;
    // Only the main process supplies a network transport. Without one (unit
    // tests, headless tools) the quota feature stays off and never connects.
    this.quotaFetch = typeof quotaFetch === 'function' ? quotaFetch : null;
    this.quota = { status: 'idle' };
    this.quotaRequest = null;
    this.dir = path.join(root, 'data');
    fs.mkdirSync(this.dir, { recursive: true });
    this.store = new HistoryStore(this.dir);
    this.file = this.store.file;
    this.dirtySessions = new Set();
    this.saveQueue = Promise.resolve();
    this.historyQueue = Promise.resolve();
    this.settings = { executable: findGrokExecutable({ home }), workspace: path.join(root, 'Workspace'), rainEnabled: true, musicEnabled: true, musicVolume: 90, subagentsEnabled: true, quotaEnabled: true, language: 'en' };
    this.t = createI18n(() => this.settings.language);
    this.sessions = [];
    this.accounts = [{ id: 'local', name: '本机 Grok 账户', nameIsDefault: true }];
    this.activeAccountId = 'local';
    this.accountManager = new Accounts({ dir: this.dir, home, getLanguage: () => this.settings.language, getWorkingDirectory: () => this.settings.workspace });
    this.accountManager.on('login', login => this.emitEvent({ type: 'account-login', ...this.accountState(), login }));
    this.loaded = new Set();
    this.permissions = new Map();
    this.retiredAdapters = new WeakSet();
    this.pendingAttachments = new Map();
    this.imageTokens = new Map();
    this.blobs = new BlobStore(path.join(this.dir, 'blobs'));
    this.store.transformMessages = messages => this.blobs.externalize(messages);
    // One reserved or running turn per conversation, keyed by session ID.
    this.turns = new Map();
    this.turnPromise = null;
    this.operation = null;
    this.closing = false;
    this.connected = false;
    this.modelCatalogRevision = 0;
    this.modelRefreshes = new Map();
    this.loadError = null;
    this.accountRecoveryError = null;
    this.journal = new TurnJournal(path.join(this.dir, 'conversations.journal'), {
      beforeFlush: () => this.blobs.flush(),
      onError: error => this.emitEvent({ type: 'error', message: this.t('保存失败：{error}', { error: error.message }) }),
    });
    this.store.beforeWrite = async () => {
      await this.blobs.flush();
      try { await this.journal.flush(); } catch {}
    };
    const hasSavedHistory = fs.existsSync(this.file);
    let hasAccountCommitMarker = false;
    if (hasSavedHistory) {
      try {
        const data = this.store.read();
        if (!Array.isArray(data.sessions) || !data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) throw new Error('Invalid saved data');
        if (!data.sessions.every(s => s && typeof s.id === 'string' && typeof s.title === 'string' && typeof s.cwd === 'string' && Array.isArray(s.messages) && s.messages.every(m => m && ['user', 'assistant'].includes(m.role) && typeof m.text === 'string'))) throw new Error('Invalid session data');
        this.settings = { ...this.settings, ...data.settings };
        this.settings.language = normalizeLanguage(this.settings.language);
        for (const key of ['rainEnabled', 'musicEnabled', 'subagentsEnabled', 'quotaEnabled']) {
          if (typeof this.settings[key] !== 'boolean') this.settings[key] = true;
        }
        if (!Number.isInteger(this.settings.musicVolume) || this.settings.musicVolume < 0 || this.settings.musicVolume > 100) this.settings.musicVolume = 90;
        const replies = readTurnJournal(this.journal.file);
        if (replies.size) for (const session of data.sessions) session.messages = session.messages.map(message => recoverReply(message, session.id, replies.get(message.id)));
        this.sessions = data.sessions;
        if (data.accounts !== undefined) {
          if (!Array.isArray(data.accounts) || !data.accounts.some(a => a?.id === 'local') || !data.accounts.every(a => a && typeof a.name === 'string' && (a.id === 'local' || ACCOUNT_ID.test(a.id))) || new Set(data.accounts.map(a => a.id)).size !== data.accounts.length) throw new Error('Invalid accounts');
          this.accounts = data.accounts.map(({ id, name, nameIsDefault }) => ({ id, name, nameIsDefault: id === 'local' && (nameIsDefault === true || (nameIsDefault === undefined && name === '本机 Grok 账户')) }));
          this.activeAccountId = this.accounts.some(a => a.id === data.activeAccountId) ? data.activeAccountId : 'local';
          hasAccountCommitMarker = true;
        }
        for (const session of this.sessions) {
          session.accountId ||= 'local';
          if (typeof session.titleIsDefault !== 'boolean') session.titleIsDefault = session.title === '新会话' && !session.messages.some(message => message.role === 'user');
          if (!this.accounts.some(a => a.id === session.accountId)) throw new Error('Unknown session account');
          // A saved choice has not yet been confirmed by this Grok process.
          session.modelSelectionVerified = false;
          for (const m of session.messages || []) {
            if (m.status === 'working') { m.status = 'cancelled'; this.dirtySessions.add(session.id); }
            // Legacy media discovery happens only when this conversation opens.
          }
        }
      } catch {
        this.sessions = [];
        this.accounts = [{ id: 'local', name: '本机 Grok 账户', nameIsDefault: true }];
        this.activeAccountId = 'local';
        const stamp = Date.now();
        const backup = `${this.file}.unreadable-${stamp}`;
        fs.copyFileSync(this.file, backup);
        const contentDirectory = path.join(this.dir, 'sessions');
        if (fs.existsSync(contentDirectory)) fs.cpSync(contentDirectory, `${backup}.sessions`, { recursive: true, dereference: false });
        this.store.files.clear();
        // Unfinished replies logged beside the unreadable history belong with it.
        try { if (this.journal.exists) fs.copyFileSync(this.journal.file, `${this.journal.file}.unreadable-${stamp}`); } catch {}
        this.loadError = this.t('历史记录文件无法读取，已保留备份：{path}', { path: backup });
      }
    }
    // A readable saved account list is the commit marker for a staged deletion.
    // Unreadable history must permanently quarantine ambiguous staged data before
    // a new, empty account list can overwrite it and appear to confirm deletion.
    if (hasAccountCommitMarker && !this.loadError) this.loadError = this.accountManager.recoverDeletes?.(this.accounts.map(a => a.id)).join('\n') || null;
    else {
      try {
        // A missing file or legacy history without an account list cannot prove
        // that a staged deletion committed.
        if (this.accountManager.preserveUnverifiedDeletes?.()) this.loadError = [this.loadError, this.t('未确认删除的账户数据已隔离至 data/accounts/.recovery-*，不会自动删除，请结合历史备份恢复。')].filter(Boolean).join('\n');
      } catch {
        this.accountRecoveryError = this.t('未能隔离未确认删除的账户数据。为保留恢复依据，暂未覆盖历史文件；请检查 data/accounts 文件夹权限后重启。');
        this.loadError = [this.loadError, this.accountRecoveryError].filter(Boolean).join('\n');
      }
    }
    fs.mkdirSync(path.join(root, 'Workspace'), { recursive: true });
    this.cleanupQueue = Promise.resolve();
    if (!this.loadError) void this.cleanAttachments().catch(error => this.emitEvent({ type: 'error', message: error.message }));
  }
  emitEvent(event) { this.emit('event', event); }
  // The most recently reserved turn, or null when every conversation is idle.
  get active() {
    let latest = null;
    for (const turn of this.turns.values()) latest = turn;
    return latest;
  }
  releaseTurn(turn) {
    if (this.turns.get(turn.sessionId) === turn) this.turns.delete(turn.sessionId);
  }
  historyOperation(action) {
    const operation = this.historyQueue.catch(() => {}).then(action);
    this.historyQueue = operation;
    return operation;
  }
  save({ content = [] } = {}) {
    if (this.accountRecoveryError) throw new Error(this.accountRecoveryError);
    for (const id of content) this.dirtySessions.add(id);
    const dirty = [...this.dirtySessions];
    this.dirtySessions.clear();
    const state = { settings: this.settings, accounts: this.accounts, activeAccountId: this.activeAccountId, sessions: this.sessions };
    // Capture the changed arrays before awaiting I/O. Later stream updates stay
    // in the journal and cannot leak into an earlier transaction.
    const committedFinal = new Set(this.sessions.filter(session => dirty.includes(session.id)).flatMap(session => session.messages.filter(message => message.status !== 'working' && (this.turns.get(session.id)?.message !== message || this.turns.get(session.id)?.settled === true)).map(message => message.id)));
    const unsettled = new Set([...this.turns.values()].filter(turn => !turn.settled && turn.message).map(turn => turn.message.id));
    this.store.unsettled = unsettled;
    const commit = this.store.save(state, dirty);
    commit.catch(() => {});
    const operation = this.saveQueue.catch(() => {}).then(async () => {
      try { await this.journal.flush(); } catch {}
      try { await commit; }
      catch (error) { for (const id of dirty) this.dirtySessions.add(id); throw error; }
      try { await this.journal.reset([...this.journal.replies.values()].filter(entry => !committedFinal.has(entry.message.id))); } catch {}
    });
    this.saveQueue = operation;
    return operation;
  }
  runningReplies() {
    return [...this.turns.values()].filter(turn => turn.message?.status === 'working').map(turn => ({ sessionId: turn.sessionId, message: turn.message }));
  }
  visibleSessions() { return this.sessions.filter(s => (s.accountId || 'local') === this.activeAccountId); }
  getSession(id) { const s = this.visibleSessions().find(s => s.id === id); if (!s) throw new Error(this.t('会话不存在或属于其他账户')); return this.prepareSession(s); }
  prepareSession(session) {
    for (const message of session.messages) {
      if (message.mediaVersion === MEDIA_VERSION) continue;
      message.images = restoreMessageImages(message);
      message.attachments = restoreMessageAttachments(message);
      Object.assign(message, this.blobs.externalize(message));
      message.mediaVersion = MEDIA_VERSION;
      this.dirtySessions.add(session.id);
    }
    return session;
  }
  readSession(id) { return this.getSession(id); }
  accountState() { return { accounts: this.accounts.map(a => this.accountManager.summary(a)), activeAccountId: this.activeAccountId, login: this.accountManager.loginState() }; }
  snapshot(error = null) { return { settings: this.settings, sessions: this.visibleSessions().map(sessionMetadata), info: this.normalizeInfo(), connected: this.connected, error, maxConcurrentTurns: MAX_CONCURRENT_TURNS, quota: this.quotaState(), ...this.accountState() }; }
  // Local preferences and history are available before the CLI's initialize and
  // session-restore round trips. Reading them must not reserve or start the engine.
  initialState() { return this.snapshot(this.loadError); }
  attachmentDirectory(accountId = this.activeAccountId) {
    return accountId === 'local' ? path.join(this.dir, 'attachments', 'local') : path.join(this.accountManager.profileDirectory(accountId), 'attachments');
  }
  async importAttachments({ files, accountId = this.activeAccountId } = {}, fromPaths = false) {
    return this.idleOperation(this.t('选择图片或附件'), async () => {
      if (accountId !== this.activeAccountId) throw new Error(this.t('附件已失效，请重新添加'));
      const staging = this.cleanupQueue.catch(() => {}).then(async () => {
        const attachments = await stageAttachments(files, this.attachmentDirectory(accountId), { fromPaths, t: this.t, nativeImage: this.nativeImage });
        for (const { previewSrc, ...attachment } of attachments) this.pendingAttachments.set(attachment.id, { ...attachment, accountId });
        return attachments;
      });
      // Cleanup shares this queue through staging and registration, so it cannot
      // mistake a just-created upload directory for an abandoned draft.
      this.cleanupQueue = staging.then(() => {});
      return staging;
    }, { duringTurns: true });
  }
  getAttachment({ sessionId, attachmentId } = {}) {
    const session = this.getSession(sessionId);
    const attachment = session.messages.flatMap(message => message.attachments || []).find(item => item.id === attachmentId);
    if (!attachment) throw new Error(this.t('附件已失效，请重新添加'));
    return { session, attachment };
  }
  async attachmentBytes(args) {
    const { session, attachment } = this.getAttachment(args);
    const accountId = this.activeAccountId;
    if (BLOB_REFERENCE.test(attachment.src)) { await this.blobs.flush(); return resolveAttachment(this.blobs.resolve(attachment.src), [this.blobs.directory], this.t); }
    const cache = /^(?:https?:\/\/|data:)/i.test(attachment.src) ? undefined : await findSessionImageDirectory(this.accountManager.homeFor(accountId), session.cwd, session.id);
    return resolveAttachment(attachment.src, [session.cwd, cache, this.attachmentDirectory(accountId)], this.t);
  }
  async imageURL({ sessionId, src } = {}) {
    this.getSession(sessionId);
    if (typeof src !== 'string' || !src || src.length > 30 * 1024 * 1024) throw new Error(this.t('不支持的图片地址'));
    const accountId = this.activeAccountId;
    // Validate before returning IPC so errors retain their localized details.
    // The prepared response is consumed by the first protocol request, without
    // decoding/encoding the image or downloading a remote image twice.
    const response = await this.imageResponse({ sessionId, src });
    const token = randomUUID();
    const entry = { sessionId, src, accountId, response, timer: null };
    entry.timer = setTimeout(() => { void entry.response?.body?.cancel().catch(() => {}); entry.response = null; }, 30000);
    entry.timer.unref?.();
    this.imageTokens.set(token, entry);
    if (this.imageTokens.size > 2048) this.dropImageToken(this.imageTokens.keys().next().value);
    return { src: `tokyo-image://media/${token}` };
  }
  dropImageToken(token) {
    const entry = this.imageTokens.get(token);
    if (!entry) return;
    clearTimeout(entry.timer);
    void entry.response?.body?.cancel().catch(() => {});
    this.imageTokens.delete(token);
  }
  async serveImage(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return new Response(null, { status: 404 }); }
    const token = parsed.pathname.slice(1);
    const args = parsed.protocol === 'tokyo-image:' && parsed.hostname === 'media' && this.imageTokens.get(token);
    if (!args || args.accountId !== this.activeAccountId || !this.visibleSessions().some(session => session.id === args.sessionId)) {
      this.dropImageToken(token);
      return new Response(null, { status: 404 });
    }
    try {
      if (args.response) { const response = args.response; args.response = null; clearTimeout(args.timer); return response; }
      return await this.imageResponse(args);
    } catch { return new Response(null, { status: 404 }); }
  }
  async imageResponse({ sessionId, src } = {}) {
    const accountId = this.activeAccountId;
    const session = this.getSession(sessionId);
    const uploaded = session.messages.some(message => (message.attachments || []).some(item => item.src === src && item.mimeType?.startsWith('image/')));
    const roots = uploaded ? [this.attachmentDirectory()] : [];
    if (BLOB_REFERENCE.test(src)) {
      const referenced = session.messages.some(message => (message.images || []).some(image => image.src === src) || (message.attachments || []).some(item => item.src === src && item.mimeType?.startsWith('image/')));
      if (!referenced) throw new Error(this.t('不支持的图片地址'));
      await this.blobs.flush();
      src = this.blobs.resolve(src);
      roots.push(this.blobs.directory);
    }
    const cache = typeof src === 'string' && /^(?:https?:\/\/|data:)/i.test(src.trim()) ? undefined
      : await findSessionImageDirectory(this.accountManager.homeFor(accountId), session.cwd, session.id);
    const response = await resolveImageResponse(src, session.cwd, cache, this.t, undefined, roots);
    if (accountId !== this.activeAccountId) { await response.body?.cancel(); throw new Error(this.t('不支持的图片地址')); }
    return response;
  }
  async readImage(args) {
    // Headless callers retain the byte API; the desktop bridge uses imageURL.
    const response = await this.imageResponse(args);
    return { src: `data:${response.headers.get('content-type')};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}` };
  }
  cleanAttachments() {
    const operation = this.cleanupQueue.catch(() => {}).then(async () => {
      for (const account of this.accounts) {
        const referenced = this.sessions.filter(session => (session.accountId || 'local') === account.id).flatMap(session => session.messages.flatMap(message => [...(message.attachments || []), ...(message.images || [])]));
        referenced.push(...[...this.pendingAttachments.values()].filter(item => item.accountId === account.id));
        await cleanupAttachments(this.attachmentDirectory(account.id), referenced);
      }
    });
    this.cleanupQueue = operation;
    return operation;
  }
  async releaseAttachments({ ids = [], accountId = this.activeAccountId } = {}) {
    if (!Array.isArray(ids)) throw new Error(this.t('无效的附件'));
    for (const id of ids) if (this.pendingAttachments.get(id)?.accountId === accountId) this.pendingAttachments.delete(id);
    await this.cleanAttachments();
    return true;
  }
  async idleOperation(name, action, { allowInterfaceSettings = false, background = false, duringTurns = false } = {}) {
    // A catalog readback is not a user action. Like a send, user operations
    // (starting a conversation, changing its model, adding files) wait for it
    // instead of failing with a transient "busy" error.
    while (!background && this.operation?.background && !this.closing && (duringTurns || !this.turns.size)) {
      await this.operation.promise.catch(() => {});
    }
    if (this.closing) throw new Error(this.t('应用正在关闭'));
    // Per-conversation work (starting, opening or configuring another chat,
    // staging files) may run beside other turns. Engine-wide changes such as
    // reconnecting, account changes and engine settings still wait for all.
    if (this.turns.size && !duringTurns) throw new Error(this.t('请等待当前回复完成，或先停止生成。'));
    if (this.operation) throw new Error(this.t('正在{name}，请稍后再试。', { name: this.operation.name }));
    // Reserve synchronously, before the first await, so a send cannot race settings.
    const operation = { name, allowInterfaceSettings, background };
    this.operation = operation;
    operation.promise = Promise.resolve().then(async () => { await this.historyQueue.catch(() => {}); return action(); });
    try { return await operation.promise; }
    finally {
      if (this.operation === operation) this.operation = null;
      this.scheduleModelRefresh();
    }
  }
  scheduleModelRefresh() {
    if (this.closing || !this.connected || this.turns.size || this.operation || this.modelRefreshTimer) return;
    if (![...this.loaded].some(id => (this.modelRefreshes.get(id) || 0) < this.modelCatalogRevision)) return;
    this.modelRefreshTimer = setTimeout(() => {
      this.modelRefreshTimer = null;
      void this.refreshModels().catch(error => this.emitEvent({ type: 'error', message: error.message }));
    }, 0);
  }
  async refreshModels() {
    if (this.closing || !this.connected || this.turns.size || this.operation) return;
    return this.idleOperation(this.t('载入会话'), async () => {
      const revision = this.modelCatalogRevision;
      const adapter = this.adapter;
      const updated = [];
      for (const session of this.visibleSessions()) {
        if (this.closing || this.turns.size || !this.connected || this.adapter !== adapter) break;
        if (!this.loaded.has(session.id) || (this.modelRefreshes.get(session.id) || 0) >= revision) continue;
        // Bound failures to one attempt per catalog revision. A global catalog
        // is not permission to widen a session-specific model allowlist.
        this.modelRefreshes.set(session.id, revision);
        if (adapter.getInfo().capabilities?.loadSession !== true) continue;
        try {
          const restored = await adapter.loadSession({ sessionId: session.id, cwd: session.cwd, force: true });
          if (this.closing || !this.connected || this.adapter !== adapter || !this.loaded.has(session.id)) break;
          this.syncSession(session, restored);
          updated.push(session);
        } catch (error) {
          this.emitEvent({ type: 'error', sessionId: session.id, message: error.message });
        }
      }
      if (updated.length) {
        await this.historyOperation(() => this.save());
        this.emitEvent({ type: 'sessions-updated', sessions: updated.map(sessionMetadata) });
        this.emitEvent({ type: 'info', info: this.normalizeInfo(), connected: this.connected });
      }
    }, { allowInterfaceSettings: true, background: true });
  }
  engineSession(id) {
    try { return this.adapter?.getSession?.(id); } catch { return undefined; }
  }
  syncSession(session, state) {
    if (!state) { session.modelSelectionVerified = false; return; }
    session.model = typeof state.model === 'string' ? state.model : '';
    session.mode = typeof state.mode === 'string' ? state.mode : '';
    session.models = Array.isArray(state.models) ? structuredClone(state.models) : [];
    session.modes = Array.isArray(state.modes) ? structuredClone(state.modes) : [];
    session.modelSelectionVerified = state.modelSelectionVerified === true;
  }
  async publishSession(session) {
    await this.historyOperation(() => this.save());
    this.emitEvent({ type: 'session-updated', sessionId: session.id, session: sessionMetadata(session) });
    this.emitEvent({ type: 'info', info: this.normalizeInfo(), connected: this.connected });
  }
  invalidateConnection() {
    this.connected = false;
    clearTimeout(this.modelRefreshTimer);
    this.modelRefreshTimer = null;
    this.modelCatalogRevision = 0;
    this.modelRefreshes.clear();
    this.loaded.clear();
    this.permissions.clear();
    for (const session of this.visibleSessions()) {
      session.modelSelectionVerified = false;
    }
    this.emitEvent({ type: 'sessions-updated', sessions: this.visibleSessions().map(sessionMetadata) });
    this.emitEvent({ type: 'info', info: this.normalizeInfo(), connected: false });
  }
  normalizeInfo() {
    const raw = this.adapter?.getInfo() || {};
    const list = (v, key) => {
      const arr = Array.isArray(v) ? v : v?.[key] || [];
      return arr.map(x => typeof x === 'string' ? { id: x, name: x } : { ...x, id: x.id || x.modelId || x.modeId, name: x.name || x.label || x.id || x.modelId || x.modeId });
    };
    return { ...raw, models: list(raw.models, 'availableModels'), modes: list(raw.modes, 'availableModes'), version: raw.version || raw.agentInfo?.version || '' };
  }
  async connect() {
    return this.idleOperation(this.t('连接 Grok'), () => this._connect());
  }
  async closeAdapter() {
    const adapter = this.adapter;
    if (!adapter) return;
    // Stop accepting events immediately, but retain process ownership until its
    // exit is confirmed so a failed shutdown remains retryable.
    this.retiredAdapters.add(adapter);
    await adapter.close();
    if (this.adapter === adapter) this.adapter = null;
  }
  async _connect() {
    if (this.accountManager.pending?.accountId === this.activeAccountId) throw new Error(this.t('请先完成账户登录'));
    if (this.activeAccountId !== 'local' && !this.accountManager.summary(this.accounts.find(a => a.id === this.activeAccountId)).signedIn) throw new Error(this.t('请打开左侧“账户切换”，登录当前账户。'));
    if (this.connected) return this.normalizeInfo();
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (!isExecutable(this.settings.executable)) throw new Error(this.t('没有找到 Grok。请在设置中选择 Grok CLI。'));
      if (!isPathType(this.settings.workspace, 'isDirectory')) throw new Error(this.t('工作目录不存在，请在设置中重新选择。'));
      await this.closeAdapter();
      this.loaded.clear();
      this.adapter = new this.Adapter({ executable: this.settings.executable, cwd: this.settings.workspace, subagentsEnabled: this.settings.subagentsEnabled, env: this.accountManager.environment(this.activeAccountId), getLanguage: () => this.settings.language });
      const adapter = this.adapter;
      adapter.on('event', event => { if (this.adapter === adapter && !this.retiredAdapters.has(adapter)) this.handleEvent(event); });
      try { await adapter.start(); }
      catch (error) {
        this.invalidateConnection();
        try { await this.closeAdapter(); } catch {}
        throw error;
      }
      this.connected = true;
      this.emitEvent({ type: 'info', info: this.normalizeInfo(), connected: true });
      return this.normalizeInfo();
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }
  async bootstrap() {
    return this.idleOperation(this.t('初始化 Grok'), async () => {
      let error = this.loadError;
      // First launch has no credentials. Keep login available immediately instead
      // of locking it behind an ACP startup that may wait for authentication.
      if (!this.accountManager.summary(this.accounts.find(account => account.id === this.activeAccountId)).signedIn) return this.snapshot(error);
      try {
        await this._connect();
        if (!this.visibleSessions().length) await this._createSession({});
        else {
          try { await this._ensureLoaded(this.visibleSessions()[0]); }
          catch (e) {
            error = e.message;
            // An unavailable history directory must not block new work in the
            // valid default directory, including engines that reveal models only
            // after a session has been opened.
            if (!this.normalizeInfo().models.length) await this._createSession({});
          }
        }
      } catch (e) { error = e.message; }
      // The quota uses the account's saved sign-in, not the engine connection.
      this.scheduleQuotaRefresh(0);
      return this.snapshot(error);
    }, { allowInterfaceSettings: true });
  }
  async createSession(options = {}) {
    return this.idleOperation(this.t('创建会话'), () => this._createSession(options), { duringTurns: true });
  }
  async _createSession({ cwd, model, mode } = {}) {
    await this._connect();
    cwd = cwd || this.settings.workspace;
    if (!isPathType(cwd, 'isDirectory')) throw new Error(this.t('请选择有效的工作目录'));
    // The response already includes the catalog known when creation started.
    // A notification received during the request still needs a later refresh.
    const revision = this.modelCatalogRevision;
    const created = await this.adapter.newSession({ cwd, model, mode });
    const session = { id: created.sessionId, accountId: this.activeAccountId, title: '新会话', titleIsDefault: true, cwd, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    this.syncSession(session, created);
    this.sessions.unshift(session);
    this.loaded.add(session.id);
    this.modelRefreshes.set(session.id, revision);
    try { await this.save(); }
    catch (error) { this.sessions = this.sessions.filter(item => item !== session); this.loaded.delete(session.id); this.modelRefreshes.delete(session.id); throw error; }
    this.emitEvent({ type: 'session-updated', sessionId: session.id, session });
    this.emitEvent({ type: 'info', info: this.normalizeInfo(), connected: this.connected });
    return session;
  }
  async ensureLoaded(session) {
    // Restoring a session does not replace settings. Keep local preferences
    // usable when startup also restores a conversation selected in the UI.
    return this.idleOperation(this.t('载入会话'), () => this._ensureLoaded(session), { allowInterfaceSettings: true, duringTurns: true });
  }
  async _ensureLoaded(session) {
    if ((session.accountId || 'local') !== this.activeAccountId) throw new Error(this.t('请先切换到这段对话所属的账户'));
    await this._connect();
    try {
      const engineState = this.engineSession(session.id);
      // Failed configuration verification can invalidate the adapter's cache even
      // though this controller previously loaded the conversation successfully.
      if (!this.loaded.has(session.id) || !engineState || engineState.loaded === false) {
        const revision = this.modelCatalogRevision;
        const restored = await this.adapter.loadSession({ sessionId: session.id, cwd: session.cwd });
        this.syncSession(session, restored);
        this.loaded.add(session.id);
        this.modelRefreshes.set(session.id, revision);
      } else this.syncSession(session, engineState);
    } catch (error) {
      session.modelSelectionVerified = false;
      this.loaded.delete(session.id);
      await this.publishSession(session);
      throw error;
    }
    await this.publishSession(session);
    return session;
  }
  async selectSession(id) {
    const session = this.getSession(id);
    // History remains readable offline and while another operation owns the engine.
    if (!this.connected || !this.loaded.has(id)) session.modelSelectionVerified = false;
    // Other conversations may keep generating while this one is opened.
    if (this.connected && !this.operation) {
      try { await this.ensureLoaded(session); }
      catch (error) { this.emitEvent({ type: 'error', sessionId: id, message: error.message }); }
    }
    return session;
  }
  async configureSession({ sessionId, model, mode } = {}) {
    return this.idleOperation(this.t('更新会话配置'), async () => {
      const session = this.getSession(sessionId);
      if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw new Error(this.t('请选择有效的模型'));
      if (mode !== undefined && (typeof mode !== 'string' || !mode.trim())) throw new Error(this.t('请选择有效的推理档位'));
      // A running conversation keeps its configuration until its turn ends.
      if (this.turns.has(session.id)) throw new Error(this.t('请等待当前回复完成，或先停止生成。'));
      await this._ensureLoaded(session);
      try {
        if (model !== undefined && (model !== session.model || !session.modelSelectionVerified)) {
          await this.adapter.setModel({ sessionId, model });
          this.syncSession(session, this.engineSession(sessionId));
        }
        if (mode !== undefined && mode !== session.mode) {
          await this.adapter.setMode({ sessionId, mode });
        }
        session.updatedAt = Date.now();
        return session;
      } finally {
        // A model may succeed before a mode fails. Report only the state Grok confirmed.
        this.syncSession(session, this.engineSession(sessionId));
        await this.publishSession(session);
      }
    }, { duringTurns: true });
  }
  async send({ sessionId, text = '', attachments = [] }) {
    if (this.turns.has(sessionId)) throw new Error(this.t('已有回复正在生成'));
    if (this.closing) throw new Error(this.t('应用正在关闭'));
    if (this.turns.size >= MAX_CONCURRENT_TURNS) throw new Error(this.t('最多同时运行 {count} 个任务，请等待其中一个完成。', { count: MAX_CONCURRENT_TURNS }));
    const backgroundOperation = this.operation;
    if (backgroundOperation && !backgroundOperation.background) throw new Error(this.t('正在{name}，请稍后再发送。', { name: backgroundOperation.name }));
    if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) throw new Error(this.t('每条消息最多添加 10 个附件'));
    if (typeof text !== 'string' || (!text.trim() && !attachments.length)) throw new Error(this.t('请输入内容'));
    if (text.length > 200000) throw new Error(this.t('消息过长，请缩短到 200,000 字以内'));
    const session = this.getSession(sessionId);
    const selected = attachments.map(item => {
      const stored = this.pendingAttachments.get(typeof item === 'string' ? item : item?.id);
      if (!stored || stored.accountId !== this.activeAccountId) throw new Error(this.t('附件已失效，请重新添加'));
      const { accountId, ...attachment } = stored;
      return attachment;
    });
    if (new Set(selected.map(item => item.id)).size !== selected.length) throw new Error(this.t('无效的附件'));
    if (selected.reduce((total, item) => total + item.size, 0) > MAX_TOTAL_BYTES) throw new Error(this.t('每条消息的附件总大小不能超过 50 MB'));
    // Reserve the turn before awaiting session restore to prevent double sends.
    const turn = { sessionId, message: null, cancelled: false, promise: null };
    this.turns.set(sessionId, turn);
    try {
      // A catalog refresh can begin between createSession and this send IPC.
      // Reserve the turn while it finishes so one click sends exactly once and
      // cancellation, account changes and other sends cannot race the wait.
      if (backgroundOperation) await backgroundOperation.promise;
      if (!turn.cancelled) {
        for (const item of selected) await resolveAttachment(item.src, [this.attachmentDirectory()], this.t);
        await this._ensureLoaded(session);
      }
    } catch (e) { this.releaseTurn(turn); this.scheduleModelRefresh(); throw e; }
    if (turn.cancelled) { this.releaseTurn(turn); this.scheduleModelRefresh(); this.emitEvent({ type: 'status', sessionId, status: 'cancelled' }); return { accepted: false, cancelled: true }; }
    let message;
    await this.historyOperation(async () => {
      if (turn.cancelled) return;
      const now = Date.now();
      const previous = { messages: session.messages.length, title: session.title, titleIsDefault: session.titleIsDefault, updatedAt: session.updatedAt };
      session.messages.push({ id: randomUUID(), role: 'user', text: text.trim(), ...(selected.length ? { attachments: selected, images: selected.filter(item => item.mimeType.startsWith('image/')).map(item => ({ src: item.src, alt: item.name })) } : {}), createdAt: now, status: 'complete' });
      message = { id: randomUUID(), role: 'assistant', text: '', responseSegments: [], thought: '', tools: [], images: [], attachments: [], plan: [], createdAt: now, status: 'working' };
      session.messages.push(message);
      if (session.titleIsDefault === true || (session.titleIsDefault === undefined && session.title === '新会话' && previous.messages === 0)) {
        // Truncate by code point so an emoji at the limit never leaves a broken half.
        session.title = Array.from((text.trim() || selected.map(item => item.name).join(', ')).replace(/\s+/g, ' ')).slice(0, 32).join('');
        session.titleIsDefault = false;
      }
      session.updatedAt = now;
      try { await this.save({ content: [session.id] }); }
      catch (error) {
        session.messages.length = previous.messages;
        session.title = previous.title;
        session.titleIsDefault = previous.titleIsDefault;
        session.updatedAt = previous.updatedAt;
        this.releaseTurn(turn);
        this.scheduleModelRefresh();
        throw new Error(this.t('保存失败，消息尚未发送：{error}', { error: error.message }));
      }
    });
    if (!message) { this.releaseTurn(turn); this.scheduleModelRefresh(); return { accepted: false, cancelled: true }; }
    for (const item of selected) this.pendingAttachments.delete(item.id);
    turn.message = message;
    this.journal.begin(sessionId, message);
    this.emitEvent({ type: 'session-updated', sessionId, session });
    this.emitEvent({ type: 'status', sessionId, status: 'working' });
    const adapter = this.adapter;
    turn.promise = (async () => {
      try {
        const result = turn.cancelled ? { cancelled: true } : await adapter.prompt({ sessionId, text: text.trim(), ...(selected.length ? { attachments: selected.map(item => ({ ...item, path: item.src, uri: pathToFileURL(item.src).href })) } : {}) });
        if (message.status === 'working') message.status = result?.cancelled || result?.stopReason === 'cancelled' ? 'cancelled' : 'complete';
        if (typeof result?.stopReason === 'string') message.stopReason = result.stopReason;
        if (message.status !== 'cancelled' && Object.hasOwn(STOP_NOTICES, result?.stopReason)) message.noticeKey = STOP_NOTICES[result.stopReason];
      } catch (e) {
        if (message.status !== 'cancelled') {
          message.status = 'error'; message.error = e.message;
          this.emitEvent({ type: 'error', sessionId, message: e.message });
        }
      } finally {
        turn.settled = true;
        applyReplyUpdate(message, { type: 'scan-attachments' }, sessionId, nested => this.emitEvent(nested));
        message.mediaVersion = MEDIA_VERSION;
        // Other conversations keep their own pending permission requests.
        for (const [requestId, permission] of this.permissions) {
          if (permission.sessionId === sessionId || (!permission.sessionId && !this.turns.size)) this.permissions.delete(requestId);
        }
        session.updatedAt = Date.now();
        try { await this.historyOperation(() => this.save({ content: [session.id] })); }
        catch (error) { this.emitEvent({ type: 'error', sessionId, message: this.t('保存失败：{error}', { error: error.message }) }); }
        this.releaseTurn(turn);
        this.emitEvent({ type: 'session-updated', sessionId, session });
        this.emitEvent({ type: 'status', sessionId, status: message.status === 'cancelled' ? 'cancelled' : 'idle' });
        this.scheduleModelRefresh();
        // Stopped and failed turns can still consume usage. The CLI records it
        // when the turn ends, so read the quota again shortly afterwards.
        this.scheduleQuotaRefresh(QUOTA_AFTER_TURN_DELAY, QUOTA_AFTER_TURN_INTERVAL);
      }
    })();
    this.turnPromise = turn.promise;
    return { accepted: true, ...(turn.cancelled ? { cancelled: true } : {}) };
  }
  handleEvent(event) {
    if (event.replay || (['text', 'image', 'attachment'].includes(event.type) && event.role === 'user')) return;
    if (event.type === 'status' && event.status === 'disconnected') this.invalidateConnection();
    if (event.type === 'status' && event.status === 'models_changed') {
      if (Number.isSafeInteger(event.revision) && event.revision > this.modelCatalogRevision) {
        this.modelCatalogRevision = event.revision;
        this.emitEvent({ type: 'info', info: this.normalizeInfo(), connected: this.connected });
        this.scheduleModelRefresh();
      }
    }
    if (event.type === 'status' && ['model_changed', 'mode_changed'].includes(event.status)) {
      const session = this.visibleSessions().find(item => item.id === event.sessionId);
      if (session) {
        this.syncSession(session, this.engineSession(session.id));
        void this.publishSession(session).catch(error => this.emitEvent({ type: 'error', message: error.message }));
      }
    }
    if (event.type === 'permission') this.permissions.set(String(event.requestId), event);
    if (event.type === 'status' && event.status === 'permission_resolved') this.permissions.delete(String(event.requestId));
    // Route output to the turn of its own conversation. An event without a
    // session ID is only unambiguous while exactly one conversation is running.
    const current = event.sessionId ? this.turns.get(event.sessionId) : this.turns.size === 1 ? this.active : undefined;
    const message = current?.message;
    event = this.blobs.externalize(event);
    const isPlan = event.type === 'status' && event.status === 'plan';
    if ((['text', 'thought', 'tool', 'image', 'attachment', 'response-boundary'].includes(event.type) || isPlan) && !message) return;
    if (message) {
      const update = event;
      event = applyReplyUpdate(message, event, current.sessionId, nested => this.emitEvent(nested));
      // Log the update itself rather than rewriting the whole history.
      if (isPlan || REPLY_UPDATE_TYPES.has(update.type)) this.journal.record(current.sessionId, message.id, update);
    }
    this.emitEvent(event);
  }
  async cancel(sessionId) {
    const turn = this.turns.get(sessionId);
    if (!turn) return { cancelled: false };
    turn.cancelled = true;
    // During connection/restore there is no prompt for the adapter to cancel yet.
    if (!turn.message) return { cancelled: true };
    const previousStatus = turn.message.status;
    turn.message.status = 'cancelled';
    try { return await this.adapter.cancel(sessionId); }
    catch (error) {
      if (this.turns.get(sessionId) === turn) { turn.cancelled = false; turn.message.status = previousStatus; }
      throw error;
    }
  }
  async permission({ requestId, optionId } = {}) {
    const pending = this.permissions.get(String(requestId));
    if (this.closing || !pending || pending.responding || !Array.isArray(pending.options) || !pending.options.some(x => x?.optionId === optionId)) throw new Error(this.t('授权请求已失效'));
    pending.responding = true;
    try {
      await this.adapter.respondPermission({ requestId, optionId });
      if (this.permissions.get(String(requestId)) === pending) this.permissions.delete(String(requestId));
    } catch (error) {
      if (this.permissions.get(String(requestId)) === pending) pending.responding = false;
      throw error;
    }
  }
  async saveSettings(patch) {
    if (this.closing) throw new Error(this.t('应用正在关闭'));
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error(this.t('无效的设置'));
    const changes = {};
    if (patch.language !== undefined) {
      if (typeof patch.language !== 'string' || !Object.hasOwn(languages, patch.language)) throw new Error(this.t('请选择支持的界面语言'));
      changes.language = patch.language;
    }
    if (patch.executable !== undefined) {
      if (!isExecutable(patch.executable)) throw new Error(this.t('请选择有效的 Grok CLI'));
      changes.executable = patch.executable;
    }
    if (patch.workspace !== undefined) {
      if (!isPathType(patch.workspace, 'isDirectory')) throw new Error(this.t('请选择有效的工作目录'));
      changes.workspace = patch.workspace;
    }
    if (patch.rainEnabled !== undefined) {
      if (typeof patch.rainEnabled !== 'boolean') throw new Error(this.t('雨景开关必须为布尔值'));
      changes.rainEnabled = patch.rainEnabled;
    }
    if (patch.musicEnabled !== undefined) {
      if (typeof patch.musicEnabled !== 'boolean') throw new Error(this.t('背景音乐开关必须为布尔值'));
      changes.musicEnabled = patch.musicEnabled;
    }
    if (patch.musicVolume !== undefined) {
      if (!Number.isInteger(patch.musicVolume) || patch.musicVolume < 0 || patch.musicVolume > 100) throw new Error(this.t('背景音乐音量必须为 0 到 100 的整数'));
      changes.musicVolume = patch.musicVolume;
    }
    if (patch.subagentsEnabled !== undefined) {
      if (typeof patch.subagentsEnabled !== 'boolean') throw new Error(this.t('子代理开关必须为布尔值'));
      changes.subagentsEnabled = patch.subagentsEnabled;
    }
    if (patch.quotaEnabled !== undefined) {
      if (typeof patch.quotaEnabled !== 'boolean') throw new Error(this.t('额度显示开关必须为布尔值'));
      changes.quotaEnabled = patch.quotaEnabled;
    }
    const changed = ['executable', 'workspace', 'subagentsEnabled'].some(key => Object.hasOwn(changes, key) && changes[key] !== this.settings[key]);
    const persist = () => this.historyOperation(async () => {
      if (changed) {
        this.invalidateConnection();
        await this.closeAdapter();
      }
      const previous = this.settings;
      // Interface preferences may have been saved while this change waited for
      // a background catalog refresh. Preserve fields this request did not set.
      this.settings = { ...previous, ...changes };
      try { await this.save(); } catch (error) { this.settings = previous; throw error; }
      if (this.settings.quotaEnabled !== previous.quotaEnabled) {
        // Turning the quota off stops all further requests immediately.
        this.resetQuota();
        if (this.settings.quotaEnabled) this.scheduleQuotaRefresh(0);
        else this.setQuota({ status: 'disabled' });
      }
      return this.settings;
    });
    // Startup does not write settings, so interface preferences can be saved
    // while initialize/session restore is pending, just as during generation.
    // Other operations may have captured settings before awaiting a teardown;
    // retain their lock so they cannot overwrite a concurrent preference save.
    if (!changed) {
      if (this.operation && !this.operation.allowInterfaceSettings) throw new Error(this.t('正在{name}，请稍后再试。', { name: this.operation.name }));
      return persist();
    }
    return this.idleOperation(this.t('保存设置'), persist);
  }
  async reconnect() {
    return this.idleOperation(this.t('重新连接 Grok'), async () => {
      this.invalidateConnection();
      await this._connect();
      if (this.visibleSessions()[0]) {
        try { await this._ensureLoaded(this.visibleSessions()[0]); }
        catch (error) { this.emitEvent({ type: 'error', sessionId: this.visibleSessions()[0].id, message: error.message }); }
      }
      if (!this.normalizeInfo().models.length) await this._createSession({});
      return this.normalizeInfo();
    });
  }
  async renameSession({ sessionId, title }) {
    if (this.operation && !this.operation.allowInterfaceSettings) throw new Error(this.t('正在{name}，请稍后再试。', { name: this.operation.name }));
    if (typeof title !== 'string' || !title.trim()) throw new Error(this.t('请输入会话名称'));
    const s = this.getSession(sessionId);
    const previous = s.title;
    const previousDefault = s.titleIsDefault;
    s.title = Array.from(title.trim()).slice(0, 120).join('');
    s.titleIsDefault = false;
    try { await this.save(); } catch (error) { s.title = previous; s.titleIsDefault = previousDefault; throw error; }
    return s;
  }
  async deleteSession(id) {
    if (this.turns.has(id)) throw new Error(this.t('请先停止当前回复'));
    if (this.operation) throw new Error(this.t('正在{name}，请稍后再删除会话。', { name: this.operation.name }));
    this.getSession(id);
    const previous = this.sessions;
    this.sessions = this.sessions.filter(s => s.id !== id || (s.accountId || 'local') !== this.activeAccountId);
    try { await this.save(); } catch (error) { this.sessions = previous; throw error; }
    this.loaded.delete(id);
    await this.cleanAttachments();
    return true;
  }
  sessionTitle(session) {
    return session.titleIsDefault === true ? this.t('新会话') : session.title;
  }
  exportSource(src) { return BLOB_REFERENCE.test(src) ? this.blobs.resolve(src) : src; }
  exportMarkdown(id) {
    const s = this.getSession(id);
    return `# ${this.sessionTitle(s)}\n\n${this.t('工作目录：{path}', { path: s.cwd })}\n\n` + s.messages.map(m => {
      const plan = Array.isArray(m.plan) && m.plan.length ? `\n\n### ${this.t('执行计划')}\n\n` + m.plan.map(entry => `- [${entry.status === 'completed' ? 'x' : ' '}] ${entry.content}`).join('\n') : '';
      const images = (m.images || []).map(image => `\n\n![${String(image.altIsDefault === true || (image.altIsDefault === undefined && image.alt === 'Grok 返回的图片') ? this.t('Grok 返回的图片') : image.alt || this.t('图片')).replace(/[\[\]\\]/g, '')}](<${this.exportSource(image.src).replace(/>/g, '%3E')}>)`).join('');
      const notice = m.noticeKey ? `\n\n${this.t(m.noticeKey)}` : '';
      const attachments = (m.attachments || []).filter(item => !item.mimeType?.startsWith('image/')).map(item => `\n\n[${String(item.name).replace(/[\[\]\\]/g, '')}](<${this.exportSource(item.src).replace(/>/g, '%3E')}>)`).join('');
      return `## ${m.role === 'user' ? this.t('你') : 'Grok'}\n\n${m.text || ''}${plan}${images}${attachments}${notice}${m.error ? '\n\n' + this.t('错误：') + m.error : ''}\n`;
    }).join('\n');
  }
  async close() {
    this.closing = true;
    for (const token of this.imageTokens.keys()) this.dropImageToken(token);
    clearTimeout(this.modelRefreshTimer);
    this.modelRefreshTimer = null;
    this.resetQuota();
    clearInterval(this.quotaPoll);
    this.quotaPoll = null;
    // Cancel pending sends before waiting on a possibly slow login shutdown.
    for (const turn of this.turns.values()) {
      turn.cancelled = true;
      if (turn.message) turn.message.status = 'cancelled';
    }
    let failure;
    const initialLogin = this.accountManager.pending;
    try { await this.accountManager.cancelLogin(); } catch (error) { failure = error; }
    if (this.operation) await this.operation.promise.catch(() => {});
    if (this.connecting) await this.connecting.catch(() => {});
    if (this.accountManager.pending && this.accountManager.pending !== initialLogin) {
      try { await this.accountManager.cancelLogin(); } catch (error) { failure ||= error; }
    }
    try { await this.historyOperation(() => this.save({ content: [...this.turns.keys()] })); } catch (error) { failure ||= error; }
    try {
      const running = [...this.turns.values()].map(turn => turn.promise).filter(Boolean);
      // A full/unavailable disk must never leave the owned Grok process running.
      await this.closeAdapter();
      await Promise.all(running);
    } catch (error) { failure ||= error; }
    finally { this.journal.cancel(); await this.cleanupQueue.catch(() => {}); await this.saveQueue.catch(() => {}); }
    if (failure) throw failure;
  }

}
for (const name of ['renameSession', 'deleteSession']) {
  const method = AppController.prototype[name];
  AppController.prototype[name] = function (...args) { return this.historyOperation(() => method.apply(this, args)); };
}
for (const group of [ControllerAccounts, ControllerQuota]) {
  const { constructor, ...methods } = Object.getOwnPropertyDescriptors(group.prototype);
  Object.defineProperties(AppController.prototype, methods);
}
module.exports = { AppController, MAX_CONCURRENT_TURNS };
