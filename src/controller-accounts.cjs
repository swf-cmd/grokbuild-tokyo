'use strict';
const { randomUUID } = require('node:crypto');
const { isExecutable } = require('./platform.cjs');
class ControllerAccounts {
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
      try { await this.save(); } catch (error) { this.accounts.pop(); throw error; }
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
      try { await this.save(); } catch (error) { account.name = previousName; account.nameIsDefault = previousDefault; throw error; }
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
      if (wasActive) { this.activeAccountId = 'local'; this.resetQuota(); }
      try { await this.save(); }
      catch (error) {
        Object.assign(this, previous);
        if (staged) {
          try { this.accountManager.restoreDelete(id); }
          catch { throw new Error(this.t('账户删除未保存，本地数据已保留，重启应用后会尝试恢复。保存错误：{error}', { error: error.message })); }
        }
        throw error;
      }
      for (const [key, item] of this.pendingAttachments) if (item.accountId === id) this.pendingAttachments.delete(key);
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
        this.scheduleQuotaRefresh(0);
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
      try { await this.save(); } catch (error) { this.activeAccountId = previous; throw error; }
      // Another account's quota must never remain visible after switching.
      this.resetQuota();
      // Clear the old account in the UI before connecting or replaying new history.
      this.emitEvent({ type: 'account-changed', state: this.snapshot() });
      let error = null;
      try {
        await this._connect();
        const session = this.visibleSessions()[0];
        if (session) await this._ensureLoaded(session); else await this._createSession({});
      } catch (e) { error = e.message; }
      this.scheduleQuotaRefresh(0);
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
}
module.exports = { ControllerAccounts };
