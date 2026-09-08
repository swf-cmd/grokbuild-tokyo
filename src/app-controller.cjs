const { createI18n, languages, normalizeLanguage } = require('./i18n.js');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { GrokAdapter } = require('./grok-adapter.cjs');
const { findGrokExecutable, isExecutable } = require('./platform.cjs');
const { AccountManager, ACCOUNT_ID } = require('./account-manager.cjs');
const { imagesFromTools, restoreMessageImages, resolveImage, findSessionImageDirectory } = require('./media.cjs');
const { MAX_ATTACHMENTS, MAX_TOTAL_BYTES, stageAttachments, attachmentsFromTools, restoreMessageAttachments, attachmentsFromText, resolveAttachment } = require('./attachments.cjs');
const { pathToFileURL } = require('node:url');

function isPathType(value, type) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return false;
  try { return fs.statSync(value)[type](); } catch { return false; }
}

const STOP_NOTICES = {
  max_tokens: '回复达到输出长度上限，可发送消息让 Grok 继续。',
  max_turn_requests: '本轮已达到请求次数上限，可发送消息让 Grok 继续。',
  refusal: 'Grok 拒绝了这次请求。',
};

class AppController extends EventEmitter {
  constructor({ root, home, Adapter = GrokAdapter, Accounts = AccountManager }) {
    super();
    this.root = root;
    this.Adapter = Adapter;
    this.dir = path.join(root, 'data');
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'conversations.json');
    this.settings = { executable: findGrokExecutable({ home }), workspace: path.join(root, 'Workspace'), rainEnabled: true, musicEnabled: true, musicVolume: 90, subagentsEnabled: true, language: 'en' };
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
    this.active = null;
    this.operation = null;
    this.closing = false;
    this.connected = false;
    this.loadError = null;
    this.accountRecoveryError = null;
    const hasSavedHistory = fs.existsSync(this.file);
    let hasAccountCommitMarker = false;
    if (hasSavedHistory) {
      try {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (!Array.isArray(data.sessions) || !data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) throw new Error('Invalid saved data');
        if (!data.sessions.every(s => s && typeof s.id === 'string' && typeof s.title === 'string' && typeof s.cwd === 'string' && Array.isArray(s.messages) && s.messages.every(m => m && ['user', 'assistant'].includes(m.role) && typeof m.text === 'string'))) throw new Error('Invalid session data');
        this.settings = { ...this.settings, ...data.settings };
        this.settings.language = normalizeLanguage(this.settings.language);
        for (const key of ['rainEnabled', 'musicEnabled', 'subagentsEnabled']) {
          if (typeof this.settings[key] !== 'boolean') this.settings[key] = true;
        }
        if (!Number.isInteger(this.settings.musicVolume) || this.settings.musicVolume < 0 || this.settings.musicVolume > 100) this.settings.musicVolume = 90;
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
            if (m.status === 'working') m.status = 'cancelled';
            m.images = restoreMessageImages(m);
            m.attachments = restoreMessageAttachments(m);
          }
        }
      } catch {
        this.sessions = [];
        this.accounts = [{ id: 'local', name: '本机 Grok 账户', nameIsDefault: true }];
        this.activeAccountId = 'local';
        const backup = `${this.file}.unreadable-${Date.now()}`;
        fs.copyFileSync(this.file, backup);
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
  }
  emitEvent(event) { this.emit('event', event); }
  save() {
    if (this.accountRecoveryError) throw new Error(this.accountRecoveryError);
    clearTimeout(this.saveTimer);
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ version: 2, settings: this.settings, accounts: this.accounts, activeAccountId: this.activeAccountId, sessions: this.sessions }, null, 2), 'utf8');
    fs.renameSync(temp, this.file);
  }
  scheduleSave() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => { try { this.save(); } catch (e) { this.emitEvent({ type: 'error', message: this.t('保存失败：{error}', { error: e.message }) }); } }, 350); }
  visibleSessions() { return this.sessions.filter(s => (s.accountId || 'local') === this.activeAccountId); }
  getSession(id) { const s = this.visibleSessions().find(s => s.id === id); if (!s) throw new Error(this.t('会话不存在或属于其他账户')); return s; }
  accountState() { return { accounts: this.accounts.map(a => this.accountManager.summary(a)), activeAccountId: this.activeAccountId, login: this.accountManager.loginState() }; }
  snapshot(error = null) { return { settings: this.settings, sessions: this.visibleSessions(), info: this.normalizeInfo(), connected: this.connected, error, ...this.accountState() }; }
  // Local preferences and history are available before the CLI's initialize and
  // session-restore round trips. Reading them must not reserve or start the engine.
  initialState() { return this.snapshot(this.loadError); }
  listAccounts() { return this.accountState(); }
  accountName(name, exceptId) {
    if (typeof name !== 'string' || !name.trim() || Array.from(name.trim()).length > 60) throw new Error(this.t('请输入 1 到 60 字的账户名称'));
    const trimmed = name.trim();
    const comparable = value => value.normalize('NFKC').toLowerCase();
    if (this.accounts.some(account => account.id !== exceptId && comparable(account.name) === comparable(trimmed))) throw new Error(this.t('已存在同名账户，请使用其他名称'));
    return trimmed;
  }
  async accountOperation(name, action) {
    return this.idleOperation(name, () => {
      if (this.accountManager.pending) throw new Error(this.t('请先完成或取消账户登录'));
      return action();
    });
  }
  async addAccount({ name } = {}) {
    return this.accountOperation(this.t('添加账户'), async () => {
      const account = { id: randomUUID(), name: this.accountName(name) };
      this.accounts.push(account);
      try { this.save(); } catch (error) { this.accounts.pop(); throw error; }
      return this.accountManager.summary(account);
    });
  }
  async renameAccount(id, name) {
    return this.accountOperation(this.t('重命名账户'), async () => {
      const account = this.accounts.find(a => a.id === id);
      if (!account) throw new Error(this.t('账户不存在'));
      const nextName = this.accountName(name, id);
      const previousName = account.name;
      const previousDefault = account.nameIsDefault;
      account.name = nextName;
      account.nameIsDefault = false;
      try { this.save(); } catch (error) { account.name = previousName; account.nameIsDefault = previousDefault; throw error; }
      const state = this.snapshot();
      this.emitEvent({ type: 'account-changed', state });
      return state;
    });
  }
  async deleteAccount(id) {
    return this.accountOperation(this.t('删除账户'), async () => {
      if (!this.accounts.some(a => a.id === id)) throw new Error(this.t('账户不存在'));
      if (id === 'local') throw new Error(this.t('本机 Grok 账户不能删除，新增账户可以移除'));
      // Validate the actual owned directory before touching the engine or files.
      this.accountManager.profileDirectory(id);
      const wasActive = this.activeAccountId === id;
      if (wasActive) {
        this.invalidateConnection();
        await this.closeAdapter();
      }
      const staged = this.accountManager.stageDelete(id);
      const previous = { accounts: this.accounts, sessions: this.sessions, activeAccountId: this.activeAccountId };
      this.accounts = this.accounts.filter(a => a.id !== id);
      this.sessions = this.sessions.filter(s => (s.accountId || 'local') !== id);
      if (wasActive) this.activeAccountId = 'local';
      try { this.save(); }
      catch (error) {
        Object.assign(this, previous);
        if (staged) {
          try { this.accountManager.restoreDelete(id); }
          catch { throw new Error(this.t('账户删除未保存，本地数据已保留，重启应用后会尝试恢复。保存错误：{error}', { error: error.message })); }
        }
        throw error;
      }
      const errors = [];
      if (staged) {
        try { this.accountManager.completeDelete(id); }
        catch { errors.push(this.t('账户已移除，但登录凭据或缓存尚未完全清理；请检查 data/accounts 文件夹权限并重启应用以重试清理。')); }
      }
      this.emitEvent({ type: 'account-changed', state: this.snapshot(errors.join('\n') || null) });
      if (wasActive) {
        try {
          await this._connect();
          const session = this.visibleSessions()[0];
          if (session) await this._ensureLoaded(session); else await this._createSession({});
        } catch (error) { errors.push(this.t('账户已移除，已切回本机账户。{error}', { error: error.message })); }
      }
      return this.snapshot(errors.join('\n') || null);
    });
  }
  async switchAccount(id) {
    return this.idleOperation(this.t('切换账户'), async () => {
      if (!this.accounts.some(a => a.id === id)) throw new Error(this.t('账户不存在'));
      if (this.accountManager.pending) throw new Error(this.t('请先完成或取消账户登录'));
      this.invalidateConnection();
      await this.closeAdapter();
      const previous = this.activeAccountId;
      this.activeAccountId = id;
      try { this.save(); } catch (error) { this.activeAccountId = previous; throw error; }
      // Clear the old account in the UI before connecting or replaying new history.
      this.emitEvent({ type: 'account-changed', state: this.snapshot() });
      let error = null;
      try {
        await this._connect();
        const session = this.visibleSessions()[0];
        if (session) await this._ensureLoaded(session); else await this._createSession({});
      } catch (e) { error = e.message; }
      return this.snapshot(error);
    });
  }
  async loginAccount(id) {
    return this.idleOperation(this.t('启动账户登录'), async () => {
      const account = this.accounts.find(a => a.id === id);
      if (!account) throw new Error(this.t('账户不存在'));
      if (this.accountManager.pending) throw new Error(this.t('已有账户正在登录'));
      if (!isExecutable(this.settings.executable)) throw new Error(this.t('请在设置中选择有效的 Grok CLI'));
      if (id === this.activeAccountId) {
        this.invalidateConnection();
        await this.closeAdapter();
      }
      if (this.closing) throw new Error(this.t('应用正在关闭'));
      return this.accountManager.startLogin(account, this.settings.executable, this.settings.workspace);
    });
  }
  async cancelAccountLogin() { await this.accountManager.cancelLogin(); return this.accountState(); }
  attachmentDirectory(accountId = this.activeAccountId) {
    return accountId === 'local' ? path.join(this.dir, 'attachments', 'local') : path.join(this.accountManager.profileDirectory(accountId), 'attachments');
  }
  async importAttachments({ files, accountId = this.activeAccountId } = {}, fromPaths = false) {
    return this.idleOperation(this.t('选择图片或附件'), async () => {
      if (accountId !== this.activeAccountId) throw new Error(this.t('附件已失效，请重新添加'));
      const attachments = await stageAttachments(files, this.attachmentDirectory(accountId), { fromPaths, t: this.t });
      for (const { previewSrc, ...attachment } of attachments) this.pendingAttachments.set(attachment.id, { ...attachment, accountId });
      return attachments;
    });
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
    const cache = /^(?:https?:\/\/|data:)/i.test(attachment.src) ? undefined : await findSessionImageDirectory(this.accountManager.homeFor(accountId), session.cwd, session.id);
    return resolveAttachment(attachment.src, [session.cwd, cache, this.attachmentDirectory(accountId)], this.t);
  }
  async readImage({ sessionId, src } = {}) {
    const session = this.getSession(sessionId);
    try {
      const uploaded = session.messages.flatMap(message => message.attachments || []).find(item => item.src === src && item.mimeType?.startsWith('image/'));
      if (uploaded) {
        const bytes = await resolveAttachment(src, [this.attachmentDirectory(), session.cwd], this.t);
        return resolveImage(`data:${uploaded.mimeType};base64,${bytes.toString('base64')}`, session.cwd, undefined, this.t);
      }
      const cache = typeof src === 'string' && /^(?:https?:\/\/|data:)/i.test(src.trim()) ? undefined
        : await findSessionImageDirectory(this.accountManager.homeFor(this.activeAccountId), session.cwd, session.id);
      return await resolveImage(src, session.cwd, cache, this.t);
    }
    catch (error) { throw new Error(error.code === 'ENOENT' ? this.t('找不到图片文件，文件可能已移动或删除') : error.message); }
  }
  async idleOperation(name, action, { allowInterfaceSettings = false } = {}) {
    if (this.closing) throw new Error(this.t('应用正在关闭'));
    if (this.active) throw new Error(this.t('请等待当前回复完成，或先停止生成。'));
    if (this.operation) throw new Error(this.t('正在{name}，请稍后再试。', { name: this.operation.name }));
    // Reserve synchronously, before the first await, so a send cannot race settings.
    const operation = { name, allowInterfaceSettings };
    this.operation = operation;
    operation.promise = Promise.resolve().then(action);
    try { return await operation.promise; }
    finally { if (this.operation === operation) this.operation = null; }
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
  publishSession(session) {
    this.save();
    this.emitEvent({ type: 'session-updated', sessionId: session.id, session });
    this.emitEvent({ type: 'info', info: this.normalizeInfo(), connected: this.connected });
  }
  invalidateConnection() {
    this.connected = false;
    this.loaded.clear();
    this.permissions.clear();
    for (const session of this.visibleSessions()) {
      session.modelSelectionVerified = false;
      this.emitEvent({ type: 'session-updated', sessionId: session.id, session });
    }
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
      return this.snapshot(error);
    }, { allowInterfaceSettings: true });
  }
  async createSession(options = {}) {
    return this.idleOperation(this.t('创建会话'), () => this._createSession(options));
  }
  async _createSession({ cwd, model, mode } = {}) {
    await this._connect();
    cwd = cwd || this.settings.workspace;
    if (!isPathType(cwd, 'isDirectory')) throw new Error(this.t('请选择有效的工作目录'));
    const created = await this.adapter.newSession({ cwd, model, mode });
    const session = { id: created.sessionId, accountId: this.activeAccountId, title: '新会话', titleIsDefault: true, cwd, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    this.syncSession(session, created);
    this.sessions.unshift(session);
    this.loaded.add(session.id);
    try { this.save(); }
    catch (error) { this.sessions = this.sessions.filter(item => item !== session); this.loaded.delete(session.id); throw error; }
    this.emitEvent({ type: 'session-updated', sessionId: session.id, session });
    this.emitEvent({ type: 'info', info: this.normalizeInfo(), connected: this.connected });
    return session;
  }
  async ensureLoaded(session) {
    // Restoring a session does not replace settings. Keep local preferences
    // usable when startup also restores a conversation selected in the UI.
    return this.idleOperation(this.t('载入会话'), () => this._ensureLoaded(session), { allowInterfaceSettings: true });
  }
  async _ensureLoaded(session) {
    if ((session.accountId || 'local') !== this.activeAccountId) throw new Error(this.t('请先切换到这段对话所属的账户'));
    await this._connect();
    try {
      const engineState = this.engineSession(session.id);
      // Failed configuration verification can invalidate the adapter's cache even
      // though this controller previously loaded the conversation successfully.
      if (!this.loaded.has(session.id) || !engineState || engineState.loaded === false) {
        const restored = await this.adapter.loadSession({ sessionId: session.id, cwd: session.cwd });
        this.syncSession(session, restored);
        this.loaded.add(session.id);
      } else this.syncSession(session, engineState);
    } catch (error) {
      session.modelSelectionVerified = false;
      this.loaded.delete(session.id);
      this.publishSession(session);
      throw error;
    }
    this.publishSession(session);
    return session;
  }
  async selectSession(id) {
    const session = this.getSession(id);
    // History remains readable offline and while another operation owns the engine.
    if (!this.connected || !this.loaded.has(id)) session.modelSelectionVerified = false;
    if (this.connected && !this.active && !this.operation) {
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
        this.publishSession(session);
      }
    });
  }
  async send({ sessionId, text = '', attachments = [] }) {
    if (this.active) throw new Error(this.t('已有回复正在生成'));
    if (this.closing) throw new Error(this.t('应用正在关闭'));
    if (this.operation) throw new Error(this.t('正在{name}，请稍后再发送。', { name: this.operation.name }));
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
    const turn = { sessionId, message: null, cancelled: false };
    this.active = turn;
    try {
      for (const item of selected) await resolveAttachment(item.src, [this.attachmentDirectory()], this.t);
      await this._ensureLoaded(session);
    } catch (e) { this.active = null; throw e; }
    if (turn.cancelled) { this.active = null; this.emitEvent({ type: 'status', sessionId, status: 'cancelled' }); return { accepted: false, cancelled: true }; }
    const now = Date.now();
    const previous = { messages: session.messages.length, title: session.title, titleIsDefault: session.titleIsDefault, updatedAt: session.updatedAt };
    session.messages.push({ id: randomUUID(), role: 'user', text: text.trim(), ...(selected.length ? { attachments: selected, images: selected.filter(item => item.mimeType.startsWith('image/')).map(item => ({ src: item.src, alt: item.name })) } : {}), createdAt: now, status: 'complete' });
    const message = { id: randomUUID(), role: 'assistant', text: '', thought: '', tools: [], images: [], attachments: [], plan: [], createdAt: now, status: 'working' };
    session.messages.push(message);
    if (session.titleIsDefault === true || (session.titleIsDefault === undefined && session.title === '新会话' && previous.messages === 0)) {
      session.title = (text.trim() || selected.map(item => item.name).join(', ')).replace(/\s+/g, ' ').slice(0, 32);
      session.titleIsDefault = false;
    }
    session.updatedAt = now;
    try { this.save(); }
    catch (error) {
      session.messages.length = previous.messages;
      session.title = previous.title;
      session.titleIsDefault = previous.titleIsDefault;
      session.updatedAt = previous.updatedAt;
      this.active = null;
      throw new Error(this.t('保存失败，消息尚未发送：{error}', { error: error.message }));
    }
    this.active.message = message;
    this.emitEvent({ type: 'session-updated', sessionId, session });
    this.emitEvent({ type: 'status', sessionId, status: 'working' });
    this.turnPromise = (async () => {
      try {
        const result = await this.adapter.prompt({ sessionId, text: text.trim(), ...(selected.length ? { attachments: selected.map(item => ({ ...item, path: item.src, uri: pathToFileURL(item.src).href })) } : {}) });
        if (message.status === 'working') message.status = result?.cancelled || result?.stopReason === 'cancelled' ? 'cancelled' : 'complete';
        if (typeof result?.stopReason === 'string') message.stopReason = result.stopReason;
        if (message.status !== 'cancelled' && Object.hasOwn(STOP_NOTICES, result?.stopReason)) message.noticeKey = STOP_NOTICES[result.stopReason];
      } catch (e) {
        if (message.status !== 'cancelled') {
          message.status = 'error'; message.error = e.message;
          this.emitEvent({ type: 'error', sessionId, message: e.message });
        }
      } finally {
        this.permissions.clear();
        this.active = null;
        session.updatedAt = Date.now();
        try { this.save(); }
        catch (error) { this.emitEvent({ type: 'error', sessionId, message: this.t('保存失败：{error}', { error: error.message }) }); }
        this.emitEvent({ type: 'session-updated', sessionId, session });
        this.emitEvent({ type: 'status', sessionId, status: message.status === 'cancelled' ? 'cancelled' : 'idle' });
      }
    })();
    return { accepted: true };
  }
  handleEvent(event) {
    if (event.replay || (['text', 'image', 'attachment'].includes(event.type) && event.role === 'user')) return;
    if (event.type === 'status' && event.status === 'disconnected') this.invalidateConnection();
    if (event.type === 'status' && ['model_changed', 'mode_changed'].includes(event.status)) {
      const session = this.visibleSessions().find(item => item.id === event.sessionId);
      if (session) {
        this.syncSession(session, this.engineSession(session.id));
        this.publishSession(session);
      }
    }
    if (event.type === 'permission') this.permissions.set(String(event.requestId), event);
    if (event.type === 'status' && event.status === 'permission_resolved') this.permissions.delete(String(event.requestId));
    const current = this.active;
    const message = current?.message;
    const isPlan = event.type === 'status' && event.status === 'plan';
    if ((['text', 'thought', 'tool', 'image', 'attachment'].includes(event.type) || isPlan) && (!message || (event.sessionId && event.sessionId !== current.sessionId))) return;
    if (message && (!event.sessionId || event.sessionId === current.sessionId)) {
      if (isPlan) {
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
        const index = message.attachments.findIndex(item => item.id === attachment.id);
        if (index >= 0) {
          // Explicit assistant output remains output even when a tool previously
          // returned the same resource. Keep that provenance across restarts.
          if (attachment.origin === 'assistant') message.attachments[index] = attachment;
          return;
        }
        message.attachments.push(attachment);
        if (event.type !== 'attachment') this.emitEvent({ type: 'attachment', sessionId: current.sessionId, attachment });
      };
      if (event.type === 'text') {
        message.text += event.text || '';
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
            this.emitEvent({ type: 'image', sessionId: current.sessionId, image });
          }
        }
      }
      if (event.type === 'error') message.error = event.message;
      this.scheduleSave();
    }
    this.emitEvent(event);
  }
  async cancel(sessionId) {
    const turn = this.active;
    if (turn?.sessionId !== sessionId) return { cancelled: false };
    turn.cancelled = true;
    // During connection/restore there is no prompt for the adapter to cancel yet.
    if (!turn.message) return { cancelled: true };
    const previousStatus = turn.message.status;
    turn.message.status = 'cancelled';
    try { return await this.adapter.cancel(sessionId); }
    catch (error) {
      if (this.active === turn) { turn.cancelled = false; turn.message.status = previousStatus; }
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
    const next = { ...this.settings };
    if (patch.language !== undefined) {
      if (typeof patch.language !== 'string' || !Object.hasOwn(languages, patch.language)) throw new Error(this.t('请选择支持的界面语言'));
      next.language = patch.language;
    }
    if (patch.executable !== undefined) {
      if (!isExecutable(patch.executable)) throw new Error(this.t('请选择有效的 Grok CLI'));
      next.executable = patch.executable;
    }
    if (patch.workspace !== undefined) {
      if (!isPathType(patch.workspace, 'isDirectory')) throw new Error(this.t('请选择有效的工作目录'));
      next.workspace = patch.workspace;
    }
    if (patch.rainEnabled !== undefined) {
      if (typeof patch.rainEnabled !== 'boolean') throw new Error(this.t('雨景开关必须为布尔值'));
      next.rainEnabled = patch.rainEnabled;
    }
    if (patch.musicEnabled !== undefined) {
      if (typeof patch.musicEnabled !== 'boolean') throw new Error(this.t('背景音乐开关必须为布尔值'));
      next.musicEnabled = patch.musicEnabled;
    }
    if (patch.musicVolume !== undefined) {
      if (!Number.isInteger(patch.musicVolume) || patch.musicVolume < 0 || patch.musicVolume > 100) throw new Error(this.t('背景音乐音量必须为 0 到 100 的整数'));
      next.musicVolume = patch.musicVolume;
    }
    if (patch.subagentsEnabled !== undefined) {
      if (typeof patch.subagentsEnabled !== 'boolean') throw new Error(this.t('子代理开关必须为布尔值'));
      next.subagentsEnabled = patch.subagentsEnabled;
    }
    const changed = next.executable !== this.settings.executable || next.workspace !== this.settings.workspace || next.subagentsEnabled !== this.settings.subagentsEnabled;
    const persist = async () => {
      if (changed) {
        this.invalidateConnection();
        await this.closeAdapter();
      }
      const previous = this.settings;
      this.settings = next;
      try { this.save(); } catch (error) { this.settings = previous; throw error; }
      return this.settings;
    };
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
  renameSession({ sessionId, title }) {
    if (typeof title !== 'string' || !title.trim()) throw new Error(this.t('请输入会话名称'));
    const s = this.getSession(sessionId);
    const previous = s.title;
    const previousDefault = s.titleIsDefault;
    s.title = title.trim().slice(0, 120);
    s.titleIsDefault = false;
    try { this.save(); } catch (error) { s.title = previous; s.titleIsDefault = previousDefault; throw error; }
    return s;
  }
  deleteSession(id) {
    if (this.active?.sessionId === id) throw new Error(this.t('请先停止当前回复'));
    if (this.operation) throw new Error(this.t('正在{name}，请稍后再删除会话。', { name: this.operation.name }));
    this.getSession(id);
    const previous = this.sessions;
    this.sessions = this.sessions.filter(s => s.id !== id || (s.accountId || 'local') !== this.activeAccountId);
    try { this.save(); } catch (error) { this.sessions = previous; throw error; }
    this.loaded.delete(id);
    return true;
  }
  sessionTitle(session) {
    return session.titleIsDefault === true ? this.t('新会话') : session.title;
  }
  exportMarkdown(id) {
    const s = this.getSession(id);
    return `# ${this.sessionTitle(s)}\n\n${this.t('工作目录：{path}', { path: s.cwd })}\n\n` + s.messages.map(m => {
      const plan = Array.isArray(m.plan) && m.plan.length ? `\n\n### ${this.t('执行计划')}\n\n` + m.plan.map(entry => `- [${entry.status === 'completed' ? 'x' : ' '}] ${entry.content}`).join('\n') : '';
      const images = (m.images || []).map(image => `\n\n![${String(image.altIsDefault === true || (image.altIsDefault === undefined && image.alt === 'Grok 返回的图片') ? this.t('Grok 返回的图片') : image.alt || this.t('图片')).replace(/[\[\]\\]/g, '')}](<${image.src.replace(/>/g, '%3E')}>)`).join('');
      const notice = m.noticeKey ? `\n\n${this.t(m.noticeKey)}` : '';
      const attachments = (m.attachments || []).filter(item => !item.mimeType?.startsWith('image/')).map(item => `\n\n[${String(item.name).replace(/[\[\]\\]/g, '')}](<${item.src.replace(/>/g, '%3E')}>)`).join('');
      return `## ${m.role === 'user' ? this.t('你') : 'Grok'}\n\n${m.text || ''}${plan}${images}${attachments}${notice}${m.error ? '\n\n' + this.t('错误：') + m.error : ''}\n`;
    }).join('\n');
  }
  async close() {
    this.closing = true;
    let failure;
    const initialLogin = this.accountManager.pending;
    try { await this.accountManager.cancelLogin(); } catch (error) { failure = error; }
    if (this.active) this.active.cancelled = true;
    if (this.active?.message) this.active.message.status = 'cancelled';
    if (this.operation) await this.operation.promise.catch(() => {});
    if (this.connecting) await this.connecting.catch(() => {});
    if (this.accountManager.pending && this.accountManager.pending !== initialLogin) {
      try { await this.accountManager.cancelLogin(); } catch (error) { failure ||= error; }
    }
    try { this.save(); } catch (error) { failure ||= error; }
    try {
      // A full/unavailable disk must never leave the owned Grok process running.
      await this.closeAdapter();
      if (this.turnPromise) await this.turnPromise;
    } catch (error) { failure ||= error; }
    finally { clearTimeout(this.saveTimer); }
    if (failure) throw failure;
  }
}
module.exports = { AppController };
