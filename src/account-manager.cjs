'use strict';

const { createI18n } = require('./i18n.js');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');
const path = require('node:path');
const { cliEnvironment } = require('./platform.cjs');
const ACCOUNT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

class AccountManager extends EventEmitter {
  constructor({ dir, home, spawnProcess = spawn, cancelTimeoutMs = 2000, getLanguage = () => 'en', getWorkingDirectory = () => process.cwd() }) {
    super();
    this.dir = dir;
    this.userHome = home;
    this.t = createI18n(getLanguage);
    this.defaultHome = path.resolve(process.env.GROK_HOME || path.join(home, '.grok'));
    this.spawnProcess = spawnProcess;
    this.getWorkingDirectory = getWorkingDirectory;
    this.cancelTimeoutMs = cancelTimeoutMs;
    this.pending = null;
  }
  homeFor(id) {
    if (id === 'local') return this.defaultHome;
    const profile = this.profileDirectory(id);
    if (fs.existsSync(this.profileDirectory(id, true)) || fs.existsSync(this.recoveryDirectory(id))) throw new Error(this.t('账户有尚未恢复的删除操作，请检查 data/accounts 的恢复数据'));
    const home = path.join(profile, 'grok');
    this.assertOwnedDirectory(home);
    return home;
  }
  assertOwnedDirectory(directory) {
    const base = path.resolve(this.dir);
    const relative = path.relative(base, path.resolve(directory));
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative) || relative.split(path.sep)[0] !== 'accounts') throw new Error(this.t('账户目录必须位于 data/accounts 内'));
    const baseStat = fs.lstatSync(base);
    if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) throw new Error(this.t('账户数据目录包含链接或不是文件夹，无法安全操作'));
    // Reject junctions/symlinks in every existing component before reading, moving,
    // or recursively deleting a profile. Missing profiles are safe to remove too.
    let current = base;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(this.t('账户目录包含链接或不是文件夹，无法安全操作'));
    }
  }
  profileDirectory(id, deleting = false) {
    if (typeof id !== 'string' || !ACCOUNT_ID.test(id)) throw new Error(id === 'local' ? this.t('本机 Grok 账户不能删除') : this.t('无效的账户'));
    const directory = path.resolve(this.dir, 'accounts', deleting ? `.deleting-${id}` : id);
    this.assertOwnedDirectory(directory);
    return directory;
  }
  recoveryDirectory(id) {
    if (typeof id !== 'string' || !ACCOUNT_ID.test(id)) throw new Error(this.t('无效的账户'));
    const directory = path.resolve(this.dir, 'accounts', `.recovery-${id}`);
    this.assertOwnedDirectory(directory);
    return directory;
  }
  preserveUnverifiedDeletes() {
    const directory = path.resolve(this.dir, 'accounts');
    this.assertOwnedDirectory(directory);
    if (!fs.existsSync(directory)) return 0;
    let count = 0;
    for (const name of fs.readdirSync(directory)) {
      const id = name.startsWith('.deleting-') ? name.slice('.deleting-'.length) : '';
      if (!ACCOUNT_ID.test(id)) continue;
      const staged = this.profileDirectory(id, true);
      const recovery = this.recoveryDirectory(id);
      if (fs.existsSync(recovery)) throw new Error(this.t('账户恢复目录已存在，无法隔离未确认的删除操作'));
      // Corrupt history cannot prove a deletion committed. Preserve these files
      // under a separate name that no subsequent startup automatically removes.
      fs.renameSync(staged, recovery);
      count++;
    }
    return count;
  }
  stageDelete(id) {
    const directory = this.profileDirectory(id);
    const canonical = value => { try { return fs.realpathSync(value); } catch (error) { if (error.code === 'ENOENT') return path.resolve(value); throw error; } };
    const relativeHome = path.relative(canonical(directory), canonical(this.defaultHome));
    if (!relativeHome || (relativeHome !== '..' && !relativeHome.startsWith('..' + path.sep) && !path.isAbsolute(relativeHome))) throw new Error(this.t('账户目录包含本机 Grok 数据，无法删除'));
    const staged = this.profileDirectory(id, true);
    if (fs.existsSync(staged)) throw new Error(this.t('账户有尚未恢复的删除操作，请重启应用后重试'));
    if (!fs.existsSync(directory)) return false;
    fs.renameSync(directory, staged);
    return true;
  }
  restoreDelete(id) {
    const directory = this.profileDirectory(id);
    const staged = this.profileDirectory(id, true);
    if (!fs.existsSync(staged)) return;
    if (fs.existsSync(directory)) throw new Error(this.t('账户原目录已存在，删除暂存数据需要恢复'));
    fs.renameSync(staged, directory);
  }
  completeDelete(id) {
    const staged = this.profileDirectory(id, true);
    fs.rmSync(staged, { recursive: true, force: true });
  }
  recoverDeletes(accountIds) {
    const directory = path.resolve(this.dir, 'accounts');
    const errors = [];
    try {
      this.assertOwnedDirectory(directory);
      if (!fs.existsSync(directory)) return errors;
      for (const name of fs.readdirSync(directory)) {
        const id = name.startsWith('.deleting-') ? name.slice('.deleting-'.length) : '';
        if (!ACCOUNT_ID.test(id)) continue;
        try {
          if (accountIds.includes(id)) this.restoreDelete(id);
          else this.completeDelete(id);
        } catch { errors.push(this.t('上次账户删除的本地数据未能恢复或清理，请检查 data/accounts 文件夹权限后重启。')); }
      }
    } catch { errors.push(this.t('账户目录不可用，请检查 data/accounts 文件夹及其权限。')); }
    return errors;
  }
  environment(id) {
    const env = { ...process.env, GROK_HOME: this.homeFor(id), NO_COLOR: '1', RUST_LOG: 'error' };
    if (id !== 'local') {
      // New profiles must not silently fall back to the original account's credentials.
      for (const key of Object.keys(env)) {
        if (/^(?:XAI_API_KEY|GROK_CODE_XAI_API_KEY|OTEL_EXPORTER_OTLP_HEADERS|GROK_CONFIG(?:_PATH)?|GROK_(?:AUTH(?:_.*)?|OIDC_.*|OAUTH2_.*|FORCE_LOGIN_TEAM.*|DEPLOYMENT_KEY|EXTRA_AUTH_KEY|TRACE_UPLOAD_CREDENTIALS_FILE|INTERNAL_OTLP_HEADERS))$/i.test(key)) delete env[key];
      }
    }
    return env;
  }
  summary(account, cwd = this.getWorkingDirectory()) {
    const result = { id: account.id, name: account.name, nameIsDefault: account.nameIsDefault === true, kind: account.id === 'local' ? 'local' : 'profile', signedIn: false, email: '' };
    const local = account.id === 'local';
    const usable = (value, inline = false) => value && typeof value === 'object' && !Array.isArray(value) && typeof value.key === 'string' && value.key.trim() && (['oidc', 'external', 'api_key'].includes(value.auth_mode) || (inline && ['web_login', 'grok'].includes(value.auth_mode)));
    let current;
    // The local CLI honors inline credentials first, then its configured store.
    // Invalid inline JSON falls back to that store, matching AuthManager::new.
    if (local && process.env.GROK_AUTH) {
      try { const inline = JSON.parse(process.env.GROK_AUTH); if (usable(inline, true)) current = inline; } catch {}
    }
    try {
      if (!current) {
        const override = local ? process.env.GROK_AUTH_PATH : undefined;
        const file = override !== undefined ? path.resolve(cwd, override) : path.join(this.homeFor(account.id), 'auth.json');
        const stat = fs.statSync(file);
        if (stat.isFile() && stat.size <= 2 * 1024 * 1024) {
          const store = JSON.parse(fs.readFileSync(file, 'utf8'));
          const credentials = store && typeof store === 'object' && !Array.isArray(store) ? Object.values(store).filter(item => usable(item)) : [];
          current = credentials.sort((a, b) => (Date.parse(b.create_time) || 0) - (Date.parse(a.create_time) || 0))[0];
        }
      }
    } catch { /* Missing or invalid configured stores must not fall back to a different account's file. */ }
    // Presence indicates configured authentication, not a network validity check.
    const apiKey = local ? process.env.XAI_API_KEY ?? process.env.GROK_CODE_XAI_API_KEY : undefined;
    result.signedIn = !!current || (typeof apiKey === 'string' && !!apiKey.trim());
    // Never return credential objects or raw CLI output across IPC.
    if (typeof current?.email === 'string') result.email = current.email.slice(0, 254);
    return result;
  }
  loginState() {
    if (!this.pending) return null;
    const { accountId, url, code, status } = this.pending;
    return { accountId, url, code, status };
  }
  startLogin(account, executable, cwd) {
    if (this.pending) throw new Error(this.t('已有账户正在登录，请先完成或取消'));
    fs.mkdirSync(this.homeFor(account.id), { recursive: true, mode: 0o700 });
    const pending = { accountId: account.id, url: '', code: '', status: 'starting', cancelled: false };
    this.pending = pending;
    let child;
    try { child = this.spawnProcess(executable, ['login', '--device-auth'], { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: cliEnvironment(this.environment(account.id), { home: this.userHome, executable }) }); }
    catch { this.pending = null; throw new Error(this.t('无法启动 Grok 登录，请检查可执行文件。')); }
    pending.child = child;
    let finish;
    pending.finished = new Promise(resolve => { finish = resolve; });
    let completed = false;
    const complete = (code, failed = false) => {
      if (completed) return;
      completed = true;
      clearTimeout(pending.timer);
      if (this.pending === pending) this.pending = null;
      const status = pending.cancelled ? 'cancelled' : !failed && code === 0 && this.summary(account, cwd).signedIn ? 'succeeded' : 'failed';
      this.emit('login', { accountId: account.id, status, error: status === 'failed' ? this.t('登录未完成，请重试并在浏览器中完成授权。') : '' });
      finish();
    };
    pending.complete = complete;
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      stream?.on('data', chunk => {
        if (completed || pending.cancelled || this.pending !== pending) return;
        buffer = (buffer + decoder.write(chunk)).slice(-16000);
        const clean = buffer.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        const urlText = clean.match(/^\s*(https:\/\/[^\s<>]+)[ \t]*\r?\n/m)?.[1];
        const codeText = clean.match(/(?:Confirm this code in your browser:|Then enter this code:)\s+([A-Z0-9-]{4,32})\s/m)?.[1];
        if (urlText) {
          try {
            const url = new URL(urlText);
            // URLSearchParams decodes escaped parameter names; a raw-string
            // check misses ?access%5Ftoken= and fragments can contain OAuth tokens.
            const secretParameter = [...url.searchParams.keys()].some(key => /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|(?:client[_-]?)?secret|password|authorization|api[_-]?key)$/i.test(key));
            if (!url.username && !url.password && !url.hash && !secretParameter) pending.url = url.href;
          } catch {}
        }
        if (codeText) pending.code = codeText;
        if (pending.url) pending.status = 'waiting';
        if (!pending.cancelled && this.pending === pending) this.emit('login', this.loginState());
      });
    }
    child.on('error', () => {
      if (completed) return;
      // ChildProcess also emits error when kill fails; that is not evidence that
      // a running login process exited and must never release its account lock.
      if ((!pending.cancelled && child.pid == null) || child.exitCode != null || child.signalCode != null) complete(null, true);
      else this.emit('login', { ...this.loginState(), error: this.t('登录进程发生错误，请取消后重试。') });
    });
    child.once('close', code => complete(code));
    pending.timer = setTimeout(() => { void this.cancelLogin().catch(() => {
      if (this.pending === pending) this.emit('login', { ...this.loginState(), error: this.t('登录已超时，无法确认登录进程已停止，请重试取消。') });
    }); }, 10 * 60 * 1000);
    pending.timer.unref?.();
    this.emit('login', this.loginState());
    return this.loginState();
  }
  async cancelLogin() {
    const pending = this.pending;
    if (!pending) return;
    if (pending.cancelling) return pending.cancelling;
    pending.cancelled = true;
    pending.status = 'cancelling';
    pending.url = '';
    pending.code = '';
    clearTimeout(pending.timer);
    this.emit('login', this.loginState());
    pending.cancelling = (async () => {
      const waitForExit = async () => {
        let timer;
        try { return await Promise.race([pending.finished.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), this.cancelTimeoutMs); })]); }
        finally { clearTimeout(timer); }
      };
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        try { pending.child.kill(signal); } catch { /* Check observed exit before reporting a recoverable cancellation failure. */ }
        if (pending.child.exitCode != null || pending.child.signalCode != null) pending.complete(null);
        if (await waitForExit()) return;
      }
      throw new Error(this.t('无法确认登录进程已停止，请重试取消或关闭应用。'));
    })();
    try { await pending.cancelling; }
    finally { pending.cancelling = null; }
  }
}

module.exports = { AccountManager, ACCOUNT_ID };
