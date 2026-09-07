const { createI18n, languages, normalizeLanguage } = require('./i18n.js');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { GrokAdapter } = require('./grok-adapter.cjs');
const { AccountManager, ACCOUNT_ID } = require('./account-manager.cjs');
const { imagesFromContent, resolveImage } = require('./media.cjs');

function isPathType(value, type) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return false;
  try { return fs.statSync(value)[type](); } catch { return false; }
}

class AppController extends EventEmitter {
  constructor({ root, home, Adapter = GrokAdapter, Accounts = AccountManager }) {
    super();
    this.root = root;
    this.Adapter = Adapter;
    this.dir = path.join(root, 'data');
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'conversations.json');
    this.settings = { executable: path.join(home, '.grok', 'bin', 'grok.exe'), workspace: path.join(root, 'Workspace'), rainEnabled: true, musicEnabled: true, musicVolume: 90, subagentsEnabled: true, language: 'zh-CN' };
    this.t = createI18n(() => this.settings.language);
    this.sessions = [];
    this.accounts = [{ id: 'local', name: '本机 Grok 账户', nameIsDefault: true }];
    this.activeAccountId = 'local';
    this.accountManager = new Accounts({ dir: this.dir, home, getLanguage: () => this.settings.language });
    this.accountManager.on('login', login => this.emitEvent({ type: 'account-login', ...this.accountState(), login }));
    this.loaded = new Set();
    this.permissions = new Map();
    this.active = null;
    this.operation = null;
    this.closing = false;
    this.connected = false;
    this.loadError = null;
    this.accountRecoveryError = null;
    if (fs.existsSync(this.file)) {
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
        }
        for (const session of this.sessions) {
          session.accountId ||= 'local';
          if (typeof session.titleIsDefault !== 'boolean') session.titleIsDefault = session.title === '新会话' && !session.messages.some(message => message.role === 'user');
          if (!this.accounts.some(a => a.id === session.accountId)) throw new Error('Unknown session account');
          // A saved choice has not yet been confirmed by this Grok process.
          session.modelSelectionVerified = false;
          for (const m of session.messages || []) {
            if (m.status === 'working') m.status = 'cancelled';
            // Older clients saved tool payloads but did not display their images.
            const images = [...(Array.isArray(m.images) ? m.images : []), ...imagesFromContent(m.tools)];
            m.images = [...new Map(images.filter(image => typeof image?.src === 'string').map(image => [image.src, image])).values()];
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
    if (!this.loadError) this.loadError = this.accountManager.recoverDeletes?.(this.accounts.map(a => a.id)).join('\n') || null;
    else {
      try {
        if (this.accountManager.preserveUnverifiedDeletes?.()) this.loadError += '\n' + this.t('未确认删除的账户数据已隔离至 data/accounts/.recovery-*，不会自动删除，请结合历史备份恢复。');
      } catch {
        this.accountRecoveryError = this.t('未能隔离未确认删除的账户数据。为保留恢复依据，暂未覆盖历史文件；请检查 data/accounts 文件夹权限后重启。');
        this.loadError += '\n' + this.accountRecoveryError;
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
        const adapter = this.adapter;
        await adapter?.close();
        this.adapter = null;
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
      const adapter = this.adapter;
      this.adapter = null;
      await adapter?.close();
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
      if (!isPathType(this.settings.executable, 'isFile')) throw new Error(this.t('请在设置中选择有效的 grok.exe'));
      if (id === this.activeAccountId) {
        this.invalidateConnection();
        const adapter = this.adapter;
        this.adapter = null;
        await adapter?.close();
      }
      if (this.closing) throw new Error(this.t('应用正在关闭'));
      return this.accountManager.startLogin(account, this.settings.executable, this.settings.workspace);
    });
  }
  async cancelAccountLogin() { await this.accountManager.cancelLogin(); return this.accountState(); }
  async readImage({ sessionId, src } = {}) {
    const session = this.getSession(sessionId);
    const cache = /^[a-zA-Z0-9_-]{1,128}$/.test(session.id) ? path.join(this.accountManager.homeFor(this.activeAccountId), 'sessions', encodeURIComponent(session.cwd), session.id) : undefined;
    try { return await resolveImage(src, session.cwd, cache, this.t); }
    catch (error) { throw new Error(error.code === 'ENOENT' ? this.t('找不到图片文件，文件可能已移动或删除') : error.message); }
  }
  async idleOperation(name, action) {
    if (this.closing) throw new Error(this.t('应用正在关闭'));
    if (this.active) throw new Error(this.t('请等待当前回复完成，或先停止生成。'));
    if (this.operation) throw new Error(this.t('正在{name}，请稍后再试。', { name: this.operation.name }));
    // Reserve synchronously, before the first await, so a send cannot race settings.
    const operation = { name };
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
  async _connect() {
    if (this.accountManager.pending?.accountId === this.activeAccountId) throw new Error(this.t('请先完成账户登录'));
    if (this.activeAccountId !== 'local' && !this.accountManager.summary(this.accounts.find(a => a.id === this.activeAccountId)).signedIn) throw new Error(this.t('请打开左侧“账户切换”，登录当前账户。'));
    if (this.connected) return this.normalizeInfo();
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (!isPathType(this.settings.executable, 'isFile')) throw new Error(this.t('没有找到 Grok。请在设置中选择 grok.exe。'));
      if (!isPathType(this.settings.workspace, 'isDirectory')) throw new Error(this.t('工作目录不存在，请在设置中重新选择。'));
      if (this.adapter) await this.adapter.close();
      this.loaded.clear();
      this.adapter = new this.Adapter({ executable: this.settings.executable, cwd: this.settings.workspace, subagentsEnabled: this.settings.subagentsEnabled, env: this.accountManager.environment(this.activeAccountId), getLanguage: () => this.settings.language });
      const adapter = this.adapter;
      adapter.on('event', event => { if (this.adapter === adapter) this.handleEvent(event); });
      try { await adapter.start(); }
      catch (error) {
        this.invalidateConnection();
        try { await adapter.close(); } catch {}
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
    });
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
    return this.idleOperation(this.t('载入会话'), () => this._ensureLoaded(session));
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
  async send({ sessionId, text }) {
    if (this.active) throw new Error(this.t('已有回复正在生成'));
    if (this.closing) throw new Error(this.t('应用正在关闭'));
    if (this.operation) throw new Error(this.t('正在{name}，请稍后再发送。', { name: this.operation.name }));
    if (typeof text !== 'string' || !text.trim()) throw new Error(this.t('请输入内容'));
    if (text.length > 200000) throw new Error(this.t('消息过长，请缩短到 200,000 字以内'));
    const session = this.getSession(sessionId);
    // Reserve the turn before awaiting session restore to prevent double sends.
    const turn = { sessionId, message: null, cancelled: false };
    this.active = turn;
    try { await this._ensureLoaded(session); } catch (e) { this.active = null; throw e; }
    if (turn.cancelled) { this.active = null; this.emitEvent({ type: 'status', sessionId, status: 'cancelled' }); return { accepted: false, cancelled: true }; }
    const now = Date.now();
    const previous = { messages: session.messages.length, title: session.title, titleIsDefault: session.titleIsDefault, updatedAt: session.updatedAt };
    session.messages.push({ id: randomUUID(), role: 'user', text: text.trim(), createdAt: now, status: 'complete' });
    const message = { id: randomUUID(), role: 'assistant', text: '', thought: '', tools: [], images: [], createdAt: now, status: 'working' };
    session.messages.push(message);
    if (session.titleIsDefault === true || (session.titleIsDefault === undefined && session.title === '新会话' && previous.messages === 0)) {
      session.title = text.trim().replace(/\s+/g, ' ').slice(0, 32);
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
        const result = await this.adapter.prompt({ sessionId, text: text.trim() });
        if (message.status === 'working') message.status = result?.cancelled || result?.stopReason === 'cancelled' ? 'cancelled' : 'complete';
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
    if (event.replay || (['text', 'image'].includes(event.type) && event.role === 'user')) return;
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
    if (['text', 'thought', 'tool', 'image'].includes(event.type) && (!message || (event.sessionId && event.sessionId !== current.sessionId))) return;
    if (message && (!event.sessionId || event.sessionId === current.sessionId)) {
      if (event.type === 'text') message.text += event.text || '';
      if (event.type === 'thought') message.thought += event.text || '';
      if (event.type === 'image' && event.image?.src) {
        message.images ||= [];
        if (!message.images.some(image => image.src === event.image.src)) message.images.push(event.image);
      }
      if (event.type === 'tool') {
        const existing = message.tools.find(t => t.toolCallId === event.toolCallId);
        if (existing) Object.assign(existing, event); else message.tools.push({ ...event });
        const images = imagesFromContent(event.content);
        for (const image of images) {
          message.images ||= [];
          if (!message.images.some(item => item.src === image.src)) message.images.push(image);
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
  async permission({ requestId, optionId }) {
    const pending = this.permissions.get(String(requestId));
    if (!pending || pending.responding || !pending.options.some(x => x.optionId === optionId)) throw new Error(this.t('授权请求已失效'));
    pending.responding = true;
    try {
      await this.adapter.respondPermission({ requestId, optionId });
      this.permissions.delete(String(requestId));
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
      if (!isPathType(patch.executable, 'isFile') || path.extname(patch.executable).toLowerCase() !== '.exe') throw new Error(this.t('请选择有效的 grok.exe'));
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
        await this.adapter?.close();
      }
      const previous = this.settings;
      this.settings = next;
      try { this.save(); } catch (error) { this.settings = previous; throw error; }
      return this.settings;
    };
    // Interface language and atmosphere changes remain usable mid-reply without restarting Grok.
    if (!changed) {
      if (this.operation) throw new Error(this.t('正在{name}，请稍后再试。', { name: this.operation.name }));
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
    return `# ${this.sessionTitle(s)}\n\n${this.t('工作目录：{path}', { path: s.cwd })}\n\n` + s.messages.map(m => `## ${m.role === 'user' ? this.t('你') : 'Grok'}\n\n${m.text || ''}${(m.images || []).map(image => `\n\n![${String(image.altIsDefault === true || (image.altIsDefault === undefined && image.alt === 'Grok 返回的图片') ? this.t('Grok 返回的图片') : image.alt || this.t('图片')).replace(/[\[\]\\]/g, '')}](<${image.src.replace(/>/g, '%3E')}>)`).join('')}${m.error ? '\n\n' + this.t('错误：') + m.error : ''}\n`).join('\n');
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
      await this.adapter?.close();
      if (this.turnPromise) await this.turnPromise;
    } catch (error) { failure ||= error; }
    finally { clearTimeout(this.saveTimer); }
    if (failure) throw failure;
  }
}
module.exports = { AppController };
