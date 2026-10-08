'use strict';
const { fetchAccountQuota } = require('./usage-quota.cjs');
// Quota reads are cheap but not free: coalesce automatic refreshes, and keep a
// slow background refresh so a weekly reset appears without user action.
const QUOTA_MIN_INTERVAL = 60 * 1000;
const QUOTA_FORCE_INTERVAL = 3 * 1000;
const QUOTA_POLL_INTERVAL = 10 * 60 * 1000;
const QUOTA_AFTER_TURN_DELAY = 8 * 1000;
const QUOTA_AFTER_TURN_INTERVAL = 15 * 1000;

class ControllerQuota {
  // Quota values are derived in the main process. Credentials and the raw
  // billing response never cross IPC; the renderer only receives this summary.
  quotaState() { return structuredClone(this.quota); }
  setQuota(quota, accountId = this.activeAccountId) {
    this.quota = { ...quota, accountId };
    this.emitEvent({ type: 'quota', quota: this.quotaState() });
    return this.quotaState();
  }
  resetQuota() {
    clearTimeout(this.quotaTimer);
    this.quotaTimer = null;
    this.quotaRequest = null;
    this.quota = { status: 'idle', accountId: this.activeAccountId };
  }
  scheduleQuotaRefresh(delay = 0, minInterval = 0) {
    if (this.closing || !this.quotaFetch || !this.settings.quotaEnabled) return;
    clearTimeout(this.quotaTimer);
    this.quotaTimer = setTimeout(() => {
      this.quotaTimer = null;
      // Even an immediate refresh skips a read that just completed.
      void this.refreshQuota({ minInterval: Math.max(minInterval, QUOTA_FORCE_INTERVAL) }).catch(() => {});
    }, delay);
    this.quotaTimer.unref?.();
    // A slow periodic read lets a weekly reset appear while the window is idle.
    if (!this.quotaPoll) {
      this.quotaPoll = setInterval(() => { if (!this.closing) void this.refreshQuota().catch(() => {}); }, QUOTA_POLL_INTERVAL);
      this.quotaPoll.unref?.();
    }
  }
  async refreshQuota({ force = false, minInterval = QUOTA_MIN_INTERVAL } = {}) {
    if (this.closing) return this.quotaState();
    const accountId = this.activeAccountId;
    if (!this.quotaFetch || !this.settings.quotaEnabled) return this.quota.status === 'disabled' ? this.quotaState() : this.setQuota({ status: 'disabled' });
    const account = this.accounts.find(item => item.id === accountId);
    let auth;
    try { auth = account && this.accountManager.credential(account); } catch { auth = null; }
    if (!auth?.credential && !auth?.apiKey) return this.setQuota({ status: 'signed-out' });
    if (this.quotaRequest?.accountId === accountId) return this.quotaRequest.promise;
    const previous = this.quota.accountId === accountId ? this.quota : null;
    const since = Date.now() - (previous?.checkedAt || 0);
    if (previous?.checkedAt && since < (force ? QUOTA_FORCE_INTERVAL : minInterval)) return this.quotaState();
    const retained = previous?.usage ? { usage: previous.usage, fetchedAt: previous.fetchedAt } : {};
    this.setQuota({ status: previous?.usage ? 'ok' : 'loading', ...retained, refreshing: true, ...(previous?.checkedAt ? { checkedAt: previous.checkedAt } : {}) });
    const request = { accountId };
    request.promise = (async () => {
      const result = await fetchAccountQuota(auth, { fetch: this.quotaFetch, clientVersion: this.normalizeInfo().version });
      // Discard a response for an account that is no longer displayed.
      if (this.closing || this.activeAccountId !== accountId || this.quotaRequest !== request) return this.quotaState();
      const checkedAt = Date.now();
      if (result.usage) return this.setQuota({ status: 'ok', usage: result.usage, fetchedAt: checkedAt, checkedAt });
      // Keep the last confirmed value visible, marked with why it is stale.
      if (retained.usage) return this.setQuota({ status: 'ok', ...retained, reason: result.reason, checkedAt });
      return this.setQuota({ status: 'unavailable', reason: result.reason, checkedAt });
    })().finally(() => { if (this.quotaRequest === request) this.quotaRequest = null; });
    this.quotaRequest = request;
    return request.promise;
  }
}
module.exports = { ControllerQuota, QUOTA_AFTER_TURN_DELAY, QUOTA_AFTER_TURN_INTERVAL };
