/* Grokbuild Tokyo — local desktop renderer. All engine access stays in preload. */
'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const api = window.tokyo;
  const isMac = api?.platform === 'darwin';
  document.documentElement.classList.toggle('platform-darwin', isMac);
  if (isMac) for (const hint of document.querySelectorAll('kbd')) hint.textContent = hint.textContent.replace('Ctrl', '⌘');
  const i18n = window.TokyoI18n;
  const t = i18n.t;
  const diagnostic = i18n.localizeDiagnostic;
  const state = {
    settings: { executable: '', workspace: '', rainEnabled: true, subagentsEnabled: true, musicEnabled: true, musicVolume: 90, language: 'en' },
    info: { models: [], modes: [], version: '' },
    sessions: [], activeId: null, connected: false, connectionStatus: 'connecting', initializing: true,
    sending: false, configuring: false, selecting: false, savingSettings: false, renaming: false, deleting: false,
    busy: new Set(), started: new Map(), permissions: new Map(),
    drafts: new Map(), selectedModel: '', selectedMode: '', menuId: null,
    renameId: null, deleteId: null, renderPending: false, lastError: '',
    accounts: [], activeAccountId: 'local', login: null, accountAction: false, accountDrafts: new Map(),
    accountRenameId: null, accountDeleteId: null, accountCancelPending: false,
  };
  const activeSession = () => state.sessions.find(s => s.id === state.activeId);
  const sessionPermissions = id => [...state.permissions.values()].filter(item => item.sessionId === id);
  const clearPermissions = id => { for (const [key, permission] of state.permissions) if (permission.sessionId === id) state.permissions.delete(key); };
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const safeText = value => typeof value === 'string' ? value : value == null ? '' : Array.isArray(value) ? value.map(safeText).join('\n') : typeof value === 'object' ? value.type === 'image' || value.resource?.blob ? t('[图片]') : value.text != null ? safeText(value.text) : value.content != null ? safeText(value.content) : JSON.stringify(value, null, 2) : String(value);
  const sessionTime = session => new Date(session.updatedAt || session.createdAt || 0).getTime() || 0;
  const sessionTitle = session => session.titleIsDefault === true || (session.titleIsDefault == null && session.title === '新会话' && !session.messages?.some(message => message.role === 'user')) ? t('新会话') : session.title || t('新的对话');
  const accountName = account => !account || account.nameIsDefault === true || (account.nameIsDefault == null && account.id === 'local' && account.name === '本机 Grok 账户') ? t('本机 Grok 账户') : account.name;
  const pathName = path => (path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path || t('选择工作空间');
  const uid = () => `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let unsubscribe;
  let unsubscribeMenu;
  let ambience;
  let searchVisible = false;
  let clockTimer;
  let clockDay;
  let clockOffset;

  function toast(message, error = false, duration = 4200) {
    message = diagnostic(safeText(message));
    for (const previous of $('toast-container').children) {
      if (previous.textContent === safeText(message)) previous.remove();
    }
    const element = document.createElement('div');
    element.className = `toast${error ? ' error' : ''}`;
    element.textContent = safeText(message);
    $('toast-container').append(element);
    setTimeout(() => element.remove(), duration);
  }

  async function call(method, ...args) {
    if (!api || typeof api[method] !== 'function') throw new Error(t('桌面连接尚未就绪，请重新启动客户端。'));
    try {
      const result = await api[method](...args);
      if (result?.error && (result.ok === false || result.success === false)) throw new Error(safeText(result.error));
      return result;
    } catch (error) { throw new Error(diagnostic(error.message || t('操作失败，请稍后重试。'))); }
  }

  async function guarded(work) {
    try { return await work(); }
    catch (error) { toast(error.message || t('操作失败，请稍后重试。'), true, 6500); return null; }
  }

  function normalizeChoices(value) {
    const list = Array.isArray(value) ? value : value?.availableModels || value?.availableModes || [];
    return list.map(item => typeof item === 'string' ? { id: item, name: item } : { ...item, id: item.id || item.modelId || item.modeId, name: item.label || item.name || item.id || item.modelId || item.modeId }).filter(item => item.id);
  }

  function normalizeInfo(info = {}) {
    return { ...state.info, ...info, models: normalizeChoices(info.models ?? state.info.models), modes: normalizeChoices(info.modes ?? state.info.modes) };
  }

  function normalizeSession(session) {
    return { ...session, messages: (session.messages || []).map(message => ({ ...message, id: message.id || uid(), role: message.role || 'assistant', text: safeText(message.text ?? message.content), thought: safeText(message.thought), tools: message.tools || [] })) };
  }

  function upsertSession(session) {
    if (!session?.id) return;
    if ((session.accountId || 'local') !== state.activeAccountId) return;
    const normalized = normalizeSession(session);
    const index = state.sessions.findIndex(item => item.id === session.id);
    if (index >= 0) state.sessions[index] = normalized;
    else state.sessions.unshift(normalized);
    const pending = normalized.messages.some(message => message.status === 'working');
    if (pending) { state.busy.add(normalized.id); if (!state.started.has(normalized.id)) state.started.set(normalized.id, Date.now()); }
  }

  function fillSelect(element, items, selected, placeholder) {
    element.replaceChildren();
    const choices = [...items];
    if (selected && !choices.some(item => item.id === selected)) choices.unshift({ id: selected, name: t('{model}（未验证）', { model: selected }), disabled: true });
    if (!selected) choices.unshift({ id: '', name: placeholder, disabled: true });
    for (const item of choices) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = element.id === 'mode-select' ? reasoningLabel(item.name) : item.name;
      option.title = item.description ? (element.id === 'mode-select' ? reasoningDescription(item.description) : item.description) : option.textContent;
      option.disabled = Boolean(item.disabled);
      element.append(option);
    }
    element.value = selected || '';
  }

  function reasoningLabel(label) {
    const key = String(label || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+effort$/, '');
    return ({ none: t('无推理'), minimal: t('最少推理'), low: t('低推理强度'), medium: t('中等推理强度'), high: t('高推理强度'), xhigh: t('超高推理强度'), 'extra high': t('超高推理强度'), max: t('最高推理强度'), maximum: t('最高推理强度') })[key] || label;
  }

  function reasoningDescription(description) {
    return ({
      'quick, fast implementations': t('快速完成实现'),
      'balanced effort with standard implementation and testing': t('平衡推理投入，完成标准实现与测试'),
      'higher implementation quality with extensive reasoning': t('通过深入推理提高实现质量'),
      'highest implementation quality with extensive reasoning': t('通过深入推理达到最高实现质量'),
      'highest effort and reasoning level': t('最高推理投入与强度'),
    })[String(description).trim().replace(/\.$/, '').toLowerCase()] || description;
  }

  function newChatModes(model = state.selectedModel) {
    const modelInfo = state.info.models.find(item => item.id === model);
    return normalizeChoices(model === state.info.currentModelId ? state.info.modes : modelInfo?.reasoningEfforts);
  }

  function syncNewChatChoices(reset = false) {
    if (reset || !state.info.models.some(item => item.id === state.selectedModel && !item.disabled)) {
      state.selectedModel = state.info.models.find(item => item.id === state.info.currentModelId && !item.disabled)?.id || '';
      state.selectedMode = '';
    }
    const modes = newChatModes();
    if (modes.some(item => item.id === state.selectedMode && !item.disabled)) return;
    const model = state.info.models.find(item => item.id === state.selectedModel);
    const current = state.selectedModel === state.info.currentModelId ? state.info.currentModeId : '';
    state.selectedMode = modes.find(item => !item.disabled && item.id === current)?.id
      || modes.find(item => !item.disabled && (item.id === model?.reasoningEffort || item.value === model?.reasoningEffort))?.id || '';
  }

  function newChatConfigReady() {
    const session = activeSession();
    if (session) {
      const modes = normalizeChoices(session.modes);
      return Boolean(session.model || session.modelId) && (!modes.length || modes.some(item => item.id === (session.mode || session.modeId) && !item.disabled));
    }
    const modes = newChatModes();
    return state.info.models.some(item => item.id === state.selectedModel && !item.disabled)
      && (!modes.length || modes.some(item => item.id === state.selectedMode && !item.disabled));
  }

  function renderConnection() {
    const pending = state.initializing || state.connectionStatus === 'connecting';
    const online = state.connected && !state.initializing;
    const label = online ? t('引擎已连接') : pending ? t('连接中') : t('引擎未连接');
    const dotClass = `connection-dot ${online ? 'online' : pending ? 'connecting' : 'offline'}`;
    for (const id of ['sidebar-dot', 'connection-dot', 'settings-dot']) $(id).className = dotClass;
    $('connection-label').textContent = label;
    $('sidebar-status').textContent = online ? t('本地引擎在线') : pending ? t('正在连接本地引擎') : t('本地引擎离线');
    $('connection-button').title = state.connected ? t('Grokbuild 已连接，点击重新连接') : t('点击重新连接 Grokbuild');
    $('settings-engine-status').textContent = state.connected ? t('Grokbuild {version} · 已连接', { version: state.info.version || '' }) : diagnostic(state.lastError) || t('Grokbuild 未连接，请检查文件路径与登录状态');
    $('settings-engine-status').title = $('settings-engine-status').textContent;
    $('version-label').textContent = state.info.version ? `v${String(state.info.version).replace(/^v/, '')}` : t('本地');
    $('version-label').title = state.info.version || t('本地 Grokbuild');
    renderSelects();
    renderComposerState();
  }

  function renderWorkspace() {
    const cwd = activeSession()?.cwd || state.settings.workspace;
    $('workspace-name').textContent = pathName(cwd);
    $('workspace-subtitle').textContent = cwd || t('让想法有个落脚点');
    $('workspace-button').title = cwd ? t('{path}\n点击更换默认工作目录', { path: cwd }) : t('选择默认工作目录');
    $('session-path').textContent = cwd || t('TOKYO / NIGHT SHIFT');
    $('session-path').title = cwd || '';
    applyAmbience();
  }

  function ambiencePreferences() {
    return $('settings-dialog').open ? {
      rainEnabled: $('rain-input').checked,
      musicEnabled: $('music-input').checked,
      musicVolume: Number($('music-volume').value),
    } : state.settings;
  }

  function renderMusicStatus(status) {
    const preferences = ambiencePreferences();
    const labels = {
      playing: t('正在播放 · 东京午夜电台 · 离线循环'),
      starting: t('正在准备东京午夜电台…'),
      blocked: t('点击窗口或按任意键，开启东京午夜电台。'),
      error: t('音乐暂时无法播放，请关闭音乐后重新开启。'),
      paused: preferences.musicEnabled && preferences.musicVolume === 0 ? t('音量为 0 · 已静音') : t('音乐已关闭'),
    };
    $('music-status').textContent = labels[status.state] || labels.starting;
    $('music-status').dataset.state = status.state;
  }

  function applyAmbience() {
    const preferences = ambiencePreferences();
    $('rain-layer').hidden = preferences.rainEnabled === false;
    $('music-volume-value').textContent = `${preferences.musicVolume}%`;
    $('music-volume').setAttribute('aria-valuetext', `${preferences.musicVolume}%`);
    ambience?.setPreferences(preferences);
    if (ambience) renderMusicStatus(ambience.getStatus());
  }

  function renderSelects() {
    const session = activeSession();
    if (!session) syncNewChatChoices();
    const models = session && Array.isArray(session.models) ? normalizeChoices(session.models) : state.info.models;
    const model = session ? session.model || session.modelId || '' : state.selectedModel;
    const modes = session ? normalizeChoices(session.modes) : newChatModes();
    const mode = session ? session.mode || session.modeId || '' : state.selectedMode;
    fillSelect($('model-select'), models, model, session ? t('未返回模型') : t('请选择模型'));
    fillSelect($('mode-select'), modes, mode, session ? t('未返回推理档位') : t('请选择推理档位'));
    const locked = state.initializing || !state.connected || state.sending || state.configuring || state.selecting || state.savingSettings || state.accountAction || !!state.login || state.busy.size > 0;
    for (const element of [$('model-select'), $('mode-select')]) {
      element.disabled = locked;
      element.title = state.login ? t('请先完成或取消账户登录。') : state.configuring ? t('正在等待 Grokbuild 确认配置…') : !state.connected ? t('离线时仅可查看历史，重新连接后可更改配置。') : state.busy.size ? t('任务结束后可更改配置。') : session ? t('更改后由 Grokbuild 确认生效，用于后续消息。') : t('新对话会明确使用所选模型和推理档位。');
    }
    if (!models.length) $('model-select').disabled = true;
    if (!modes.length) {
      $('mode-select').disabled = true;
      $('mode-select').title = t('当前模型不提供可选的推理档位。');
      if (!mode) $('mode-select').options[0].textContent = model ? t('无可选推理档位') : t('请先选择模型');
    }
    if (session?.modelSelectionVerified === false) {
      for (const element of [$('model-select'), $('mode-select')]) {
        if (element.value) element.selectedOptions[0].textContent += t('（待确认）');
        element.title += t(' 当前显示的是保存的选择，尚未经本次连接确认。');
      }
    }
  }

  function historyGroup(session) {
    const date = new Date(sessionTime(session));
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime();
    return date.getTime() >= start ? t('今天') : date.getTime() >= yesterday ? t('昨天') : t('更早');
  }

  function renderSessions() {
    const list = $('session-list');
    const query = $('session-search').value.toLocaleLowerCase().trim();
    const sessions = state.sessions.filter(session => sessionTitle(session).toLocaleLowerCase().includes(query)).sort((a, b) => sessionTime(b) - sessionTime(a));
    list.replaceChildren();
    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = query ? t('没有找到这段对话。') : t('新的故事，从这里开始。');
      list.append(empty);
      return;
    }
    let lastGroup = '';
    for (const session of sessions) {
      const group = historyGroup(session);
      if (group !== lastGroup) {
        const label = document.createElement('div');
        label.className = 'history-group-label';
        label.textContent = group;
        list.append(label);
        lastGroup = group;
      }
      const row = document.createElement('div');
      row.className = `session-item${session.id === state.activeId ? ' active' : ''}${state.busy.has(session.id) ? ' working' : ''}`;
      const select = document.createElement('button');
      select.className = 'session-select';
      select.disabled = state.initializing || state.sending || state.configuring || state.selecting || state.savingSettings;
      select.title = sessionTitle(session);
      select.setAttribute('aria-current', session.id === state.activeId ? 'page' : 'false');
      const icon = document.createElement('span');
      icon.className = 'chat-icon'; icon.textContent = state.busy.has(session.id) ? '◌' : '⌁'; icon.setAttribute('aria-hidden', 'true');
      const title = document.createElement('span');
      title.className = 'session-title'; title.textContent = sessionTitle(session);
      select.append(icon, title);
      select.addEventListener('click', () => guarded(() => selectSession(session.id)));
      const more = document.createElement('button');
      more.disabled = select.disabled;
      more.className = 'session-more'; more.textContent = '···'; more.setAttribute('aria-label', t('{title}的更多操作', { title: sessionTitle(session) }));
      more.addEventListener('click', event => { event.stopPropagation(); openSessionMenu(session.id, more); });
      row.append(select, more);
      list.append(row);
    }
  }

  function markdown(text) {
    if (window.marked && window.DOMPurify) {
      try {
        const renderer = new window.marked.Renderer();
        const image = ({ href, text }) => `<span data-image-source="${escapeHtml(href)}" data-image-alt="${escapeHtml(text || '')}"></span>`;
        renderer.image = image;
        renderer.html = ({ text }) => {
          const template = document.createElement('template'); template.innerHTML = text;
          for (const img of template.content.querySelectorAll('img')) {
            const placeholder = document.createElement('span');
            placeholder.dataset.imageSource = img.getAttribute('src') || '';
            placeholder.dataset.imageAlt = img.getAttribute('alt') || '';
            img.replaceWith(placeholder);
          }
          return template.innerHTML;
        };
        const link = renderer.link;
        renderer.link = function(token) {
          if (/\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)(?:[?#].*)?$/i.test(token.href || '')) return image(token);
          return link.call(this, token);
        };
        // Reply HTML must not create application controls, duplicate their IDs,
        // borrow application CSS classes, or initiate its own resource loads.
        return window.DOMPurify.sanitize(window.marked.parse(text || '', { breaks: true, gfm: true, renderer }), {
          ALLOWED_TAGS: ['a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'samp', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul', 'var'],
          ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan', 'start', 'reversed', 'open', 'data-image-source', 'data-image-alt'],
          // These are inert placeholders, including Windows drive paths. The
          // main-process image resolver validates them before setting img.src.
          ADD_URI_SAFE_ATTR: ['data-image-source', 'data-image-alt'],
          ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
        });
      } catch (_) { /* Fall through to safe plain text. */ }
    }
    return escapeHtml(text).replace(/\n/g, '<br>');
  }

  const imageCache = new Map();
  function createImage(source, session, messageId, previousImages) {
    const key = `${messageId}:${source.src}`;
    if (previousImages.has(key)) { const figure = previousImages.get(key); figure.localize?.(); return figure; }
    const alt = () => source.altIsDefault === true || (source.altIsDefault == null && source.alt === 'Grok 返回的图片') ? t('Grok 返回的图片') : source.alt || t('图片');
    const figure = document.createElement('figure'); figure.className = 'chat-image'; figure.imageKey = key;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'image-thumbnail'; button.disabled = true;
    button.setAttribute('aria-label', t('放大图片：{alt}', { alt: alt() }));
    const img = document.createElement('img'); img.alt = alt(); img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
    const caption = document.createElement('figcaption'); caption.textContent = t('正在加载图片…');
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'image-retry'; retry.textContent = t('重新加载'); retry.hidden = true;
    button.append(img); figure.append(button, caption, retry);
    const cacheKey = `${state.activeAccountId}:${session.id}:${source.src}`;
    let failure = '';
    const load = async () => {
      const follow = nearBottom();
      failure = ''; caption.textContent = t('正在加载图片…'); retry.hidden = true; img.hidden = false; button.disabled = true;
      try {
        let request = imageCache.get(cacheKey);
        if (!request) {
          request = call('readImage', { sessionId: session.id, src: source.src });
          imageCache.set(cacheKey, request);
          if (imageCache.size > 24) imageCache.delete(imageCache.keys().next().value);
        }
        const resolved = await request;
        img.onload = () => {
          button.disabled = false; caption.textContent = t('{alt} · 点击放大', { alt: alt() });
          if (follow && figure.isConnected) $('conversation-scroll').scrollTop = $('conversation-scroll').scrollHeight;
        };
        img.onerror = () => failed(t('图片加载失败，地址可能已失效或需要登录'));
        img.src = resolved.src;
      } catch (error) { failed(error.message); }
    };
    figure.localize = () => {
      button.setAttribute('aria-label', t('放大图片：{alt}', { alt: alt() })); img.alt = alt(); retry.textContent = t('重新加载');
      if (!button.disabled) caption.textContent = t('{alt} · 点击放大', { alt: alt() });
      else if (retry.hidden) caption.textContent = t('正在加载图片…');
      else caption.textContent = diagnostic(failure);
    };
    const failed = message => { failure = message; imageCache.delete(cacheKey); img.hidden = true; button.disabled = true; caption.textContent = diagnostic(message); retry.hidden = false; };
    retry.addEventListener('click', () => { void load(); });
    button.addEventListener('click', () => {
      $('image-title').textContent = alt();
      $('image-preview').alt = alt(); $('image-preview').referrerPolicy = 'no-referrer'; $('image-preview').src = img.src;
      $('image-dialog').showModal();
    });
    void load();
    return figure;
  }

  function mountImages(body, message, session, previousImages) {
    const seen = new Set();
    for (const placeholder of body.querySelectorAll('[data-image-source]')) {
      const src = placeholder.dataset.imageSource;
      seen.add(src);
      placeholder.replaceWith(createImage({ src, alt: placeholder.dataset.imageAlt, altIsDefault: false }, session, message.id, previousImages));
    }
    for (const image of message.images || []) {
      if (typeof image.src !== 'string' || seen.has(image.src)) continue;
      seen.add(image.src); body.append(createImage(image, session, message.id, previousImages));
    }
  }

  function attachmentSize(size) {
    if (!Number.isFinite(size) || size < 0) return '';
    return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  function mountAttachments(body, message, session) {
    if (!message.attachments?.length) return;
    const list = document.createElement('div'); list.className = 'message-attachments';
    for (const attachment of message.attachments) {
      if (!attachment?.id) continue;
      const card = document.createElement('div'); card.className = 'attachment-card'; card.dataset.attachmentId = attachment.id;
      const icon = document.createElement('span'); icon.className = 'attachment-icon'; icon.textContent = attachment.mimeType?.startsWith('image/') ? '▧' : '↳'; icon.setAttribute('aria-hidden', 'true');
      const info = document.createElement('div'); info.className = 'attachment-info';
      const name = document.createElement('span'); name.className = 'attachment-name'; name.textContent = attachment.name || t('附件'); name.title = name.textContent;
      const size = document.createElement('span'); size.className = 'attachment-size'; size.textContent = attachmentSize(attachment.size) || attachment.mimeType || t('附件');
      const save = document.createElement('button'); save.type = 'button'; save.className = 'attachment-save'; save.textContent = t('保存附件'); save.setAttribute('aria-label', t('保存附件：{name}', { name: name.textContent }));
      const accountId = state.activeAccountId;
      save.addEventListener('click', () => guarded(async () => {
        if (state.activeAccountId !== accountId) return;
        save.disabled = true;
        try {
          const result = await call('saveAttachment', { sessionId: session.id, attachmentId: attachment.id });
          if (state.activeAccountId === accountId && result?.path && !result.canceled) toast(t('附件已保存：{path}', { path: result.path }));
        } catch (error) { if (state.activeAccountId === accountId) throw error; }
        finally { save.disabled = false; }
      }));
      info.append(name, size); card.append(icon, info, save); list.append(card);
    }
    body.append(list);
  }

  function toolStatus(status) {
    return ({ pending: t('等待中'), running: t('执行中'), in_progress: t('执行中'), completed: t('已完成'), complete: t('已完成'), success: t('已完成'), failed: t('失败'), error: t('失败'), cancelled: t('已取消') })[status] || status || t('执行中');
  }

  function createTool(tool) {
    const details = document.createElement('details');
    details.className = 'tool-entry';
    details.dataset.status = tool.status || 'running';
    details.dataset.toolId = tool.toolCallId || tool.id || '';
    const summary = document.createElement('summary');
    const status = document.createElement('span');
    status.className = 'tool-state';
    status.textContent = ['completed', 'complete', 'success'].includes(tool.status) ? '✓' : ['failed', 'error'].includes(tool.status) ? '!' : '↗';
    const title = document.createElement('span');
    title.className = 'tool-title'; title.textContent = tool.title || tool.name || t('工具调用'); title.title = title.textContent;
    const label = document.createElement('span');
    label.className = 'tool-status'; label.textContent = toolStatus(tool.status);
    summary.append(status, title, label);
    const content = document.createElement('pre');
    content.textContent = safeText(tool.content ?? tool.output ?? tool.rawInput ?? tool.input) || t('等待工具返回结果…');
    details.append(summary, content);
    return details;
  }

  function createPlan(entries, messageId, openDetails, previousPlans) {
    const planId = `plan:${messageId}`;
    const details = document.createElement('details'); details.className = 'plan-details'; details.dataset.planId = planId;
    details.open = previousPlans.has(planId) ? openDetails.has(planId) : true;
    const summary = document.createElement('summary'); summary.textContent = t('执行计划');
    const list = document.createElement('ol');
    for (const entry of entries) {
      const item = document.createElement('li'); item.dataset.status = entry.status || 'pending';
      const content = document.createElement('span'); content.className = 'plan-content'; content.textContent = safeText(entry.content);
      const status = document.createElement('span'); status.className = 'plan-status'; status.textContent = toolStatus(entry.status || 'pending');
      item.append(content, status); list.append(item);
    }
    details.append(summary, list); return details;
  }

  function nearBottom() {
    const scroller = $('conversation-scroll');
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
  }

  function renderMessages(forceBottom = false) {
    const scroller = $('conversation-scroll');
    const pinned = forceBottom || nearBottom();
    const session = activeSession();
    const messages = session?.messages || [];
    const hasMessages = messages.length > 0;
    $('welcome').hidden = hasMessages;
    $('messages').hidden = !hasMessages;
    document.querySelector('.main-panel').classList.toggle('has-messages', hasMessages);
    $('breadcrumb-title').textContent = session ? sessionTitle(session) : t('新对话');
    $('export-button').disabled = !session || !messages.length;
    const openDetails = new Set([...$('messages').querySelectorAll('details[open]')].map(item => item.dataset.toolId || item.dataset.thoughtId || item.dataset.planId));
    const previousPlans = new Set([...$('messages').querySelectorAll('[data-plan-id]')].map(item => item.dataset.planId));
    const container = $('messages');
    const previousImages = new Map([...container.querySelectorAll('.chat-image')].map(figure => [figure.imageKey, figure]));
    container.replaceChildren();
    messages.forEach((message, index) => {
      const article = document.createElement('article');
      article.className = `message ${message.role === 'user' ? 'user' : 'assistant'}`;
      article.dataset.messageId = message.id;
      const heading = document.createElement('div'); heading.className = 'message-heading';
      const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.textContent = message.role === 'user' ? t('你') : '✳'; avatar.setAttribute('aria-hidden', 'true');
      const name = document.createElement('strong'); name.textContent = message.role === 'user' ? t('YOU') : 'GROKBUILD';
      const time = document.createElement('time');
      if (message.createdAt) { const date = new Date(message.createdAt); if (!Number.isNaN(date.getTime())) { time.dateTime = date.toISOString(); time.textContent = date.toLocaleTimeString(i18n.getLanguage(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } }
      heading.append(avatar, name, time); article.append(heading);
      if (message.thought) {
        const thought = document.createElement('details'); thought.className = 'thought-details'; thought.dataset.thoughtId = message.id;
        thought.open = openDetails.has(message.id);
        const summary = document.createElement('summary'); summary.textContent = t('思考过程');
        const body = document.createElement('div'); body.className = 'thought-content'; body.textContent = message.thought;
        thought.append(summary, body); article.append(thought);
      }
      if (message.tools?.length) {
        const tools = document.createElement('div'); tools.className = 'message-tools';
        for (const tool of message.tools) { const element = createTool(tool); element.open = openDetails.has(element.dataset.toolId); tools.append(element); }
        article.append(tools);
      }
      if (message.plan?.length) article.append(createPlan(message.plan, message.id, openDetails, previousPlans));
      const body = document.createElement('div'); body.className = 'message-body';
      if (message.role === 'user') body.textContent = message.text;
      else body.innerHTML = markdown(message.text);
      mountImages(body, message, session, previousImages);
      mountAttachments(body, message, session);
      const last = index === messages.length - 1;
      if (message.role === 'assistant' && last && state.busy.has(session.id)) {
        const cursor = document.createElement('span'); cursor.className = 'streaming-caret'; cursor.setAttribute('aria-label', t('正在生成')); body.append(cursor);
      }
      if (message.status === 'error') { const error = document.createElement('div'); error.className = 'message-error'; error.textContent = diagnostic(message.error) || t('本次请求未能完成，请检查引擎连接后重试。'); body.append(error); }
      if (message.noticeKey) { const notice = document.createElement('div'); notice.className = 'message-notice'; notice.textContent = t(message.noticeKey); body.append(notice); }
      if (message.status === 'cancelled') { const cancelled = document.createElement('div'); cancelled.className = 'message-cancelled'; cancelled.textContent = t('本次生成已停止'); body.append(cancelled); }
      article.append(body); container.append(article);
    });
    container.querySelectorAll('pre > code').forEach(code => {
      const button = document.createElement('button'); button.className = 'copy-code'; button.textContent = t('复制'); button.setAttribute('aria-label', t('复制代码'));
      button.addEventListener('click', async () => {
        try { await call('copyText', code.textContent); button.textContent = t('已复制'); setTimeout(() => { if (button.isConnected) button.textContent = t('复制'); }, 1800); }
        catch (_) { toast(t('无法访问剪贴板，请选择代码后复制。'), true); }
      });
      code.parentElement.append(button);
    });
    if (pinned) scroller.scrollTop = scroller.scrollHeight;
    $('scroll-bottom').hidden = !hasMessages || nearBottom();
    renderComposerState();
    renderPermissions();
  }

  function queueMessages() {
    if (state.renderPending) return;
    state.renderPending = true;
    requestAnimationFrame(() => { state.renderPending = false; renderMessages(); });
  }

  function renderComposerState() {
    const busy = state.busy.has(state.activeId);
    const draft = currentDraft();
    const changing = state.configuring || state.selecting || state.savingSettings || state.accountAction || !!state.login;
    $('send-button').hidden = busy;
    $('stop-button').hidden = !busy;
    $('send-button').disabled = state.initializing || state.sending || changing || draft.pending > 0 || state.busy.size > 0 || (!$('prompt').value.trim() && !draft.attachments.length) || !state.connected || !newChatConfigReady();
    $('attach-button').disabled = state.initializing || state.sending || state.busy.size > 0 || draft.pending > 0 || changing;
    renderDraftAttachments();
    $('settings-button').disabled = state.initializing || state.sending || changing;
    $('account-button').disabled = state.initializing || state.sending || state.configuring || state.selecting || state.savingSettings || state.accountAction;
    $('workspace-button').disabled = state.initializing || state.sending || changing || state.busy.size > 0;
    $('new-session').disabled = state.sending || changing;
    for (const element of document.querySelectorAll('.session-select, .session-more')) element.disabled = state.initializing || state.sending || changing;
    for (const element of document.querySelectorAll('[data-prompt]')) element.disabled = state.sending;
    for (const id of ['connection-button', 'settings-reconnect']) $(id).disabled = state.initializing || state.sending || changing || state.busy.size > 0 || state.connectionStatus === 'connecting';
    $('prompt').disabled = state.sending;
    $('prompt').placeholder = state.login ? t('请先完成或取消账户登录，可以先写好草稿…') : state.configuring ? t('正在等待引擎确认配置，可以先写好下一条消息…') : state.selecting ? t('正在恢复这段对话…') : !state.connected ? t('当前离线；连接引擎后可继续对话…') : busy ? t('可以先写好下一条消息，等待当前任务完成…') : state.busy.size ? t('另一段对话正在运行，可以先写下你的想法…') : t('在雨声中，开始你的下一个想法…');
    $('activity-strip').hidden = !busy;
    if (busy) updateActivity();
  }

  function updateActivity() {
    if (!state.busy.has(state.activeId)) return;
    const message = activeSession()?.messages.filter(item => item.role === 'assistant').at(-1);
    const tool = message?.tools?.filter(item => ['running', 'pending', 'in_progress'].includes(item.status)).at(-1);
    $('activity-text').textContent = sessionPermissions(state.activeId).length ? t('等待你的授权') : tool ? tool.title || t('正在执行工具') : message?.text ? t('Grokbuild 正在回答') : t('Grokbuild 正在思考');
    const start = state.started.get(state.activeId) || Date.now();
    const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000));
    $('activity-duration').textContent = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  }

  function renderPermissions() {
    const panel = $('permission-panel');
    const permissionSessionId = state.activeId;
    const permission = sessionPermissions(permissionSessionId)[0];
    panel.replaceChildren(); panel.hidden = !permission;
    if (!permission) return;
    const heading = document.createElement('div'); heading.className = 'permission-heading'; heading.textContent = permission.title || permission.toolCall?.title || t('Grokbuild 请求执行操作');
    const description = document.createElement('p'); description.className = 'permission-description';
    description.textContent = safeText(permission.toolCall?.rawInput ?? permission.toolCall?.content ?? permission.description) || t('请确认是否允许此操作。你的选择会发送给本地引擎。');
    const actions = document.createElement('div'); actions.className = 'permission-actions';
    for (const option of permission.options || []) {
      const button = document.createElement('button');
      button.textContent = ({ allow_once: t('允许一次'), allow_always: t('始终允许'), reject_once: t('拒绝一次'), reject_always: t('始终拒绝') })[option.kind] || option.name || option.optionId;
      if ((option.kind || '').startsWith('allow')) button.className = 'allow';
      button.addEventListener('click', () => guarded(async () => {
        for (const other of actions.children) other.disabled = true;
        try { await call('permission', { requestId: permission.requestId, optionId: option.optionId }); state.permissions.delete(String(permission.requestId)); renderPermissions(); updateActivity(); }
        catch (error) { for (const other of actions.children) other.disabled = false; throw error; }
      }));
      actions.append(button);
    }
    panel.append(heading, description, actions);
  }

  function currentDraft() {
    const key = state.activeId || '__new__';
    if (!state.drafts.has(key)) state.drafts.set(key, { text: '', attachments: [], pending: 0 });
    return state.drafts.get(key);
  }
  function rememberDraft() { currentDraft().text = $('prompt').value; }
  function restoreDraft() { $('prompt').value = currentDraft().text; resizePrompt(); }

  function renderDraftAttachments() {
    const draft = currentDraft();
    const list = $('attachment-drafts');
    list.hidden = !draft.attachments.length && !draft.pending;
    list.replaceChildren();
    for (const attachment of draft.attachments) {
      const card = document.createElement('div'); card.className = 'attachment-draft';
      if (/^data:image\/(?:png|jpe?g|webp|gif|avif|bmp);base64,/i.test(attachment.previewSrc || '')) {
        const img = document.createElement('img'); img.src = attachment.previewSrc; img.alt = attachment.name || t('图片'); card.append(img);
      } else {
        const icon = document.createElement('span'); icon.className = 'attachment-icon'; icon.textContent = '↳'; icon.setAttribute('aria-hidden', 'true'); card.append(icon);
      }
      const info = document.createElement('div'); info.className = 'attachment-info';
      const name = document.createElement('span'); name.className = 'attachment-name'; name.textContent = attachment.name || t('附件'); name.title = name.textContent;
      const size = document.createElement('span'); size.className = 'attachment-size'; size.textContent = attachmentSize(attachment.size);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'attachment-remove'; remove.textContent = '×'; remove.disabled = state.sending;
      remove.setAttribute('aria-label', t('移除附件：{name}', { name: name.textContent }));
      remove.addEventListener('click', () => { draft.attachments = draft.attachments.filter(item => item.id !== attachment.id); renderComposerState(); });
      info.append(name, size); card.append(info, remove); list.append(card);
    }
    if (draft.pending) {
      const pending = document.createElement('span'); pending.className = 'attachment-pending'; pending.textContent = t('正在添加附件…'); list.append(pending);
    }
  }

  async function addAttachments(files) {
    if (state.initializing || state.sending || state.busy.size > 0 || state.configuring || state.selecting || state.savingSettings || state.accountAction || state.login) return;
    const draft = currentDraft();
    if (draft.pending) return;
    const accountId = state.activeAccountId;
    draft.pending++; renderComposerState();
    try {
      let attachments;
      if (files) {
        if (files.length + draft.attachments.length > 10) throw new Error(t('每条消息最多添加 10 个附件。'));
        if (files.some(file => file.size > 20 * 1024 * 1024)) throw new Error(t('单个附件不能超过 20 MB。'));
        if ([...files, ...draft.attachments].reduce((sum, file) => sum + (file.size || 0), 0) > 50 * 1024 * 1024) throw new Error(t('每条消息的附件总大小不能超过 50 MB。'));
        const encoded = [];
        for (const file of files) {
          const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
            reader.onerror = () => reject(new Error(t('无法读取附件：{name}', { name: file.name })));
            reader.readAsDataURL(file);
          });
          encoded.push({ name: file.name, mimeType: file.type, data });
        }
        if (state.activeAccountId !== accountId) return;
        attachments = await call('importAttachments', { files: encoded, accountId });
      } else attachments = await call('chooseAttachments', { language: i18n.getLanguage(), accountId });
      if (state.activeAccountId !== accountId || !Array.isArray(attachments)) return;
      const combined = [...draft.attachments, ...attachments.filter(item => item?.id && !draft.attachments.some(previous => previous.id === item.id))];
      if (combined.length > 10) throw new Error(t('每条消息最多添加 10 个附件。'));
      if (combined.reduce((sum, file) => sum + (file.size || 0), 0) > 50 * 1024 * 1024) throw new Error(t('每条消息的附件总大小不能超过 50 MB。'));
      draft.attachments = combined;
    } catch (error) { if (state.activeAccountId === accountId) toast(error.message || t('添加附件失败，请重试。'), true, 6500); }
    finally { draft.pending--; renderComposerState(); }
  }

  function newChat() {
    if (state.sending || state.configuring || state.selecting || state.savingSettings || state.accountAction || state.login) return;
    rememberDraft();
    state.activeId = null;
    syncNewChatChoices(true);
    restoreDraft(); renderSessions(); renderSelects(); renderWorkspace(); renderMessages(true);
    $('prompt').focus();
  }

  async function selectSession(id) {
    if (state.sending || state.configuring || state.selecting || state.savingSettings || state.accountAction || state.login || id === state.activeId) return;
    rememberDraft();
    state.selecting = true; renderSelects(); renderComposerState();
    try {
      const session = await call('selectSession', id);
      if (!session?.id) throw new Error(t('无法读取这段对话。'));
      upsertSession(session);
      state.activeId = id;
      restoreDraft(); renderSessions(); renderWorkspace(); renderMessages(true);
      closeSessionMenu(); $('prompt').focus();
    } finally { state.selecting = false; renderSelects(); renderComposerState(); }
  }

  async function configureSession(patch) {
    const session = activeSession();
    if (!session || !state.connected || state.initializing || state.sending || state.configuring || state.selecting || state.savingSettings || state.accountAction || state.login || state.busy.size) { renderSelects(); return; }
    state.configuring = true; renderSelects(); renderComposerState();
    try {
      const updated = await call('configureSession', { sessionId: session.id, ...patch });
      if (updated?.id !== session.id) throw new Error(t('引擎未确认这段对话的新配置，请重新连接后重试。'));
      upsertSession(updated);
      toast(t('对话配置已由 Grokbuild 确认。'));
    } finally {
      state.configuring = false;
      renderSelects(); renderComposerState();
    }
  }

  async function prepareModel(model) {
    if (state.initializing || !state.connected || state.sending || state.configuring || state.selecting || state.savingSettings || state.accountAction || state.login || state.busy.size) { renderSelects(); return; }
    state.configuring = true; renderSelects(); renderComposerState();
    try {
      // A model without a published effort menu needs an actual session readback.
      const session = await call('createSession', { cwd: state.settings.workspace || undefined, model });
      if (!session?.id) throw new Error(t('引擎未返回该模型的配置，请重试。'));
      const draft = currentDraft(); rememberDraft();
      upsertSession(session); state.activeId = session.id;
      state.drafts.set(session.id, draft); state.drafts.delete('__new__');
      renderSessions(); renderWorkspace(); renderMessages();
    } finally { state.configuring = false; renderSelects(); renderComposerState(); }
  }

  function resizePrompt() {
    $('prompt').style.height = 'auto';
    $('prompt').style.height = `${Math.max(60, Math.min(170, $('prompt').scrollHeight))}px`;
    renderComposerState();
  }

  async function sendMessage() {
    const text = $('prompt').value.trim();
    const draft = currentDraft();
    const attachments = [...draft.attachments];
    if ((!text && !attachments.length) || draft.pending || state.initializing || state.sending || state.configuring || state.selecting || state.savingSettings || state.accountAction || state.login || state.busy.size > 0) return;
    if (!state.connected) { toast(t('请先连接本地 Grokbuild。点击右上角的连接状态可重试。'), true); return; }
    if (!newChatConfigReady()) { toast(t('请先选择具体的模型和推理档位。'), true); return; }
    state.sending = true;
    renderComposerState(); renderSelects();
    let session;
    try {
      session = activeSession();
      if (!session) {
        session = await call('createSession', { cwd: state.settings.workspace || undefined, model: state.selectedModel || undefined, mode: state.selectedMode || undefined });
        if (!session?.id) throw new Error(t('引擎未能创建对话，请重试。'));
        upsertSession(session); state.activeId = session.id;
        state.drafts.set(session.id, draft); state.drafts.delete('__new__');
      }
      state.busy.add(session.id); state.started.set(session.id, Date.now());
      $('prompt').value = ''; draft.text = ''; draft.attachments = []; resizePrompt();
      renderSessions(); renderSelects(); renderWorkspace(); renderMessages(true);
      const result = await call('send', { sessionId: session.id, text, attachments: attachments.map(({ id }) => ({ id })) });
      if (result?.accepted === false) {
        state.busy.delete(session.id); state.started.delete(session.id);
        $('prompt').value = text; draft.text = text; draft.attachments = attachments; resizePrompt();
        if (!result.cancelled) throw new Error(t('引擎未接受这条消息，请重试。'));
      }
    } catch (error) {
      if (session?.id) { state.busy.delete(session.id); state.started.delete(session.id); }
      if (!$('prompt').value) { $('prompt').value = text; draft.text = text; }
      draft.attachments = attachments; resizePrompt();
      toast(error.message || t('消息发送失败。'), true, 6500);
    } finally {
      state.sending = false; renderComposerState(); renderSelects(); renderSessions(); $('prompt').focus();
    }
  }

  function getStreamMessage(sessionId) {
    const session = state.sessions.find(item => item.id === sessionId);
    if (!session) return null;
    let message = session.messages.at(-1);
    if (!message || message.role !== 'assistant' || ['complete', 'error', 'cancelled'].includes(message.status)) {
      message = { id: uid(), role: 'assistant', text: '', thought: '', tools: [], status: 'working', createdAt: new Date().toISOString() };
      session.messages.push(message);
    }
    return message;
  }

  function onEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'account-changed') { applyAccountSnapshot(event.state); return; }
    if (event.type === 'account-login') {
      state.accounts = event.accounts || state.accounts;
      const login = event.login;
      state.login = login && ['starting', 'waiting', 'cancelling'].includes(login.status) ? login : null;
      if (login && ['succeeded', 'failed', 'cancelled'].includes(login.status)) state.loginTerminal = login.status;
      renderAccounts(); renderComposerState(); renderSelects();
      if (login?.status === 'succeeded') {
        $('account-feedback').textContent = t('登录成功，正在连接…');
        if (state.accountAction) state.loginCompletedAccount = login.accountId;
        else void accountWork(() => changeAccount(login.accountId));
      } else if (login?.status === 'failed') $('account-feedback').textContent = login.error || t('登录未完成，请重试并在浏览器中完成授权。');
      else if (login?.status === 'cancelled') $('account-feedback').textContent = t('登录已取消，可重新登录或切换账户。');
      else if (login?.error) $('account-feedback').textContent = login.error;
      return;
    }
    const sessionId = event.sessionId || event.session?.id || state.activeId;
    if (event.type === 'session-updated') {
      if (event.session) upsertSession(event.session);
      renderSessions(); if (sessionId === state.activeId) { renderSelects(); renderWorkspace(); queueMessages(); }
      return;
    }
    if (event.type === 'info') {
      state.info = normalizeInfo(event.info || event);
      if (typeof event.connected === 'boolean') state.connected = event.connected;
      renderSelects(); renderConnection(); return;
    }
    if (event.type === 'status') {
      const status = event.status;
      if (status === 'plan') {
        const message = getStreamMessage(sessionId);
        if (message) message.plan = Array.isArray(event.entries) ? event.entries : [];
        if (sessionId === state.activeId) queueMessages();
        return;
      }
      if (status === 'permission_resolved') {
        state.permissions.delete(String(event.requestId)); renderPermissions(); updateActivity(); return;
      }
      if (['connecting', 'ready', 'disconnected'].includes(status)) {
        state.connectionStatus = status;
        state.connected = status === 'ready';
        if (state.connected) state.lastError = '';
        if (status === 'disconnected') { state.busy.clear(); state.permissions.clear(); }
        renderConnection(); renderPermissions(); renderSessions(); queueMessages();
      }
      if (sessionId && ['working', 'busy'].includes(status)) {
        state.busy.add(sessionId); if (!state.started.has(sessionId)) state.started.set(sessionId, Date.now());
      }
      if (sessionId && ['idle', 'cancelled', 'error'].includes(status)) {
        state.busy.delete(sessionId); state.started.delete(sessionId); clearPermissions(sessionId);
        const session = state.sessions.find(item => item.id === sessionId);
        const last = session?.messages.at(-1);
        if (last?.role === 'assistant' && last.status === 'working') last.status = status === 'cancelled' ? 'cancelled' : status === 'error' ? 'error' : 'complete';
        if (event.stopReason === 'max_tokens') toast(t('已达到本次回复的长度限制，可以继续追问。'));
      }
      renderSessions(); if (sessionId === state.activeId) queueMessages();
      renderComposerState(); renderSelects(); return;
    }
    if (event.type === 'error') {
      state.lastError = safeText(event.message || event.error || t('本地引擎出现错误。'));
      toast(state.lastError, true, 9000); renderConnection(); renderSessions(); queueMessages(); return;
    }
    if (event.type === 'permission') {
      state.permissions.set(String(event.requestId), { ...event, sessionId });
      if (sessionId === state.activeId) { renderPermissions(); updateActivity(); }
      else toast(t('对话“{title}”需要你的授权。', { title: sessionTitle(state.sessions.find(item => item.id === sessionId) || {}) }), false, 8000);
      return;
    }
    if (['text', 'thought', 'tool', 'image', 'attachment'].includes(event.type)) {
      const message = getStreamMessage(sessionId); if (!message) return;
      const wasBusy = state.busy.has(sessionId);
      state.busy.add(sessionId);
      if (!wasBusy) { renderSelects(); renderComposerState(); }
      if (event.type === 'text') message.text = event.delta === false ? safeText(event.text) : message.text + safeText(event.text);
      if (event.type === 'thought') message.thought = event.delta === false ? safeText(event.text) : message.thought + safeText(event.text);
      if (event.type === 'image' && event.image?.src) {
        message.images ||= [];
        if (!message.images.some(image => image.src === event.image.src)) message.images.push(event.image);
      }
      if (event.type === 'attachment' && event.attachment?.id) {
        message.attachments ||= [];
        if (!message.attachments.some(attachment => attachment.id === event.attachment.id)) message.attachments.push(event.attachment);
      }
      if (event.type === 'tool') {
        const tool = event.tool || event;
        const toolId = tool.toolCallId || tool.id;
        const index = message.tools.findIndex(item => (item.toolCallId || item.id) === toolId);
        if (index >= 0) message.tools[index] = { ...message.tools[index], ...tool };
        else message.tools.push({ ...tool });
      }
      if (sessionId === state.activeId) queueMessages();
    }
  }

  function openSessionMenu(id, button) {
    state.menuId = id;
    const rect = button.getBoundingClientRect();
    const menu = $('session-menu'); menu.hidden = false;
    menu.style.left = `${Math.min(rect.right + 7, window.innerWidth - 180)}px`;
    menu.style.top = `${Math.max(55, Math.min(rect.top, window.innerHeight - 140))}px`;
    $('menu-rename').focus();
  }
  function closeSessionMenu() { $('session-menu').hidden = true; state.menuId = null; }

  function renderAccounts() {
    const current = state.accounts.find(a => a.id === state.activeAccountId);
    $('account-name').textContent = accountName(current);
    $('account-button').title = current?.email || accountName(current);
    $('account-list').replaceChildren();
    const locked = accountsLocked();
    for (const account of state.accounts) {
      const row = document.createElement('div'); row.className = 'account-row'; row.dataset.accountId = account.id;
      const selected = account.id === state.activeAccountId; row.classList.toggle('selected', selected);
      const info = document.createElement('div'); info.className = 'account-info'; const name = document.createElement('strong'); name.textContent = accountName(account);
      const detail = document.createElement('small'); detail.textContent = account.email || (account.signedIn ? t('登录已保存') : account.kind === 'local' ? t('沿用本机 Grok 登录与配置') : t('尚未登录'));
      info.append(name, detail);
      if (account.kind === 'local') {
        const note = document.createElement('small'); note.className = 'account-local-note'; note.textContent = t('默认账户不可移除，保留本机 Grok 登录与配置。'); info.append(note);
      }
      const actions = document.createElement('div'); actions.className = 'account-row-actions';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button'; button.dataset.accountAction = 'switch'; button.textContent = selected ? t('当前账户 ✓') : t('切换'); button.disabled = selected || locked;
      button.setAttribute('aria-label', selected ? t('{name}，当前账户', { name: accountName(account) }) : t('切换到{name}', { name: accountName(account) }));
      button.addEventListener('click', () => { void accountWork(() => changeAccount(account.id)); });
      const rename = document.createElement('button'); rename.type = 'button'; rename.className = 'secondary-button'; rename.dataset.accountAction = 'rename'; rename.textContent = t('重命名'); rename.disabled = locked; rename.setAttribute('aria-label', t('重命名{name}', { name: accountName(account) }));
      rename.addEventListener('click', () => openAccountRename(account));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger-button'; remove.dataset.accountAction = 'delete'; remove.textContent = t('删除'); remove.disabled = locked || account.kind !== 'profile'; remove.setAttribute('aria-label', t('删除{name}', { name: accountName(account) }));
      remove.title = account.kind === 'local' ? t('默认账户不可移除，保留本机 Grok 登录与配置。') : t('删除此客户端的账户及其本地登录与聊天记录');
      remove.addEventListener('click', () => openAccountDelete(account));
      actions.append(button, rename, remove); row.append(info, actions); $('account-list').append(row);
    }
    $('account-login').textContent = current?.signedIn ? t('重新登录当前账户') : t('登录当前账户');
    $('account-login').disabled = locked;
    $('accounts-dialog').querySelector('[data-close-dialog]').disabled = state.accountAction;
    $('account-name-input').disabled = locked; $('add-account-button').disabled = locked;
    $('account-login-panel').hidden = !state.login;
    if (state.login) {
      $('account-login-status').textContent = state.login.status === 'cancelling' ? t('正在取消登录，等待本地登录进程退出…') : state.login.status === 'waiting' ? t('等待浏览器确认登录…') : t('正在准备 Grok 登录页面…');
      $('account-open-login').hidden = !state.login.url;
      $('account-code-row').hidden = !state.login.code; $('account-login-code').textContent = state.login.code || '';
    } else {
      $('account-login-status').textContent = ''; $('account-login-code').textContent = '';
      $('account-open-login').hidden = true; $('account-code-row').hidden = true;
    }
    $('account-cancel-login').disabled = state.accountCancelPending;
    $('account-cancel-login').textContent = state.accountCancelPending ? t('正在取消…') : state.login?.status === 'cancelling' ? t('重试取消登录') : t('取消登录');
    $('account-open-login').disabled = state.accountCancelPending || state.login?.status === 'cancelling'; $('account-copy-code').disabled = state.accountCancelPending || state.login?.status === 'cancelling';
    if (state.busy.size) $('account-feedback').textContent = t('请先停止生成或等待回复完成，再切换账户。');
  }

  function accountsLocked() {
    return state.initializing || state.sending || state.configuring || state.selecting || state.savingSettings || state.accountAction || state.accountCancelPending || state.busy.size > 0 || !!state.login;
  }

  function validateAccountName(input, feedback) {
    const name = input.value.trim();
    const error = !name ? t('请输入账户名称。') : Array.from(name).length > 60 ? t('账户名称不能超过 60 个字符。') : '';
    input.setCustomValidity(error); input.setAttribute('aria-invalid', String(!!error));
    if (error) { $(feedback).textContent = error; input.reportValidity(); return null; }
    return name;
  }

  function openAccountRename(account) {
    if (accountsLocked()) return;
    state.accountRenameId = account.id; $('account-rename-feedback').textContent = '';
    const input = $('account-rename-input'); input.value = accountName(account); input.setCustomValidity(''); input.removeAttribute('aria-invalid');
    $('account-rename-dialog').showModal(); input.select();
  }

  function openAccountDelete(account) {
    if (accountsLocked() || account.kind !== 'profile') return;
    state.accountDeleteId = account.id; $('account-delete-name').textContent = account.name;
    $('account-delete-current').hidden = account.id !== state.activeAccountId;
    $('account-delete-feedback').textContent = ''; $('account-delete-dialog').showModal(); $('account-delete-cancel').focus();
  }

  async function accountDialogWork(dialogId, feedbackId, action) {
    if (accountsLocked()) return;
    const dialog = $(dialogId);
    await accountWork(async () => {
      for (const element of dialog.querySelectorAll('button, input')) element.disabled = true;
      $(feedbackId).textContent = '';
      try { await action(); dialog.close(); }
      catch (error) { $(feedbackId).textContent = error.message || t('操作失败，请重试。'); }
      finally { for (const element of dialog.querySelectorAll('button, input')) element.disabled = false; }
    });
  }

  function applyAccountSnapshot(result) {
    const survivingAccounts = new Set((result.accounts || []).map(account => account.id));
    if (result.activeAccountId !== state.activeAccountId) {
      if (survivingAccounts.has(state.activeAccountId)) {
        rememberDraft(); state.accountDrafts.set(state.activeAccountId, { drafts: state.drafts, activeId: state.activeId });
      }
      const saved = state.accountDrafts.get(result.activeAccountId);
      state.drafts = saved?.drafts || new Map();
      // null is an intentional new-conversation selection with its own draft.
      // Only a first visit to an account should default to its latest history.
      state.activeId = saved ? saved.activeId : result.sessions?.[0]?.id || null;
      imageCache.clear(); closeSessionMenu();
      if ($('image-dialog').open) $('image-dialog').close();
      $('image-preview').removeAttribute('src');
      $('session-search').value = ''; $('history-search').hidden = true; searchVisible = false;
    }
    for (const id of state.accountDrafts.keys()) if (!survivingAccounts.has(id)) state.accountDrafts.delete(id);
    for (const key of imageCache.keys()) if (!survivingAccounts.has(key.split(':')[0])) imageCache.delete(key);
    state.activeAccountId = result.activeAccountId;
    state.accounts = result.accounts || []; state.login = result.login || null;
    state.sessions = (result.sessions || []).map(normalizeSession);
    if (state.activeId !== null && !state.sessions.some(s => s.id === state.activeId)) state.activeId = state.sessions[0]?.id || null;
    state.info = { ...result.info, models: normalizeChoices(result.info?.models), modes: normalizeChoices(result.info?.modes) };
    state.connected = result.connected === true; state.connectionStatus = state.connected ? 'ready' : 'disconnected'; state.lastError = result.error || '';
    state.busy.clear(); state.permissions.clear(); state.started.clear(); syncNewChatChoices(true);
    restoreDraft(); renderAccounts(); renderSessions(); renderWorkspace(); renderSelects(); renderMessages(true); renderConnection();
  }

  async function accountWork(action) {
    if (state.accountAction) return;
    state.accountAction = true; renderAccounts(); renderComposerState(); renderSelects();
    $('account-feedback').textContent = '';
    try { return await action(); }
    catch (error) { $('account-feedback').textContent = error.message; }
    finally {
      state.accountAction = false; renderAccounts(); renderComposerState(); renderSelects();
      if (state.loginCompletedAccount) {
        const id = state.loginCompletedAccount; state.loginCompletedAccount = null;
        void accountWork(() => changeAccount(id));
      }
    }
  }

  async function changeAccount(id) {
    applyAccountSnapshot(await call('switchAccount', id));
    $('account-feedback').textContent = state.lastError || t('账户已切换。');
  }

  async function startAccountLogin() {
    state.loginTerminal = null;
    const login = await call('loginAccount', state.activeAccountId);
    if (!state.loginTerminal) state.login = login;
    renderAccounts();
  }

  function showSettings() {
    if (state.initializing) { toast(t('正在读取本地配置，请稍候。')); return; }
    if (state.sending || state.configuring || state.selecting || state.savingSettings || state.accountAction || state.login || document.querySelector('dialog[open]')) return;
    $('executable-input').value = state.settings.executable || '';
    $('workspace-input').value = state.settings.workspace || '';
    $('rain-input').checked = state.settings.rainEnabled !== false;
    $('music-input').checked = state.settings.musicEnabled !== false;
    $('music-volume').value = state.settings.musicVolume;
    $('subagents-input').checked = state.settings.subagentsEnabled !== false;
    $('language-select').value = i18n.normalizeLanguage(state.settings.language);
    $('settings-feedback').textContent = '';
    renderConnection(); updateSettingsReconnect();
    if (!$('settings-dialog').open) $('settings-dialog').showModal();
    applyAmbience();
  }

  function settingsPatch() {
    return { language: $('language-select').value, executable: $('executable-input').value.trim(), workspace: $('workspace-input').value.trim(), rainEnabled: $('rain-input').checked, subagentsEnabled: $('subagents-input').checked, musicEnabled: $('music-input').checked, musicVolume: Number($('music-volume').value) };
  }

  function updateSettingsReconnect() {
    const dirty = Object.entries(settingsPatch()).some(([key, value]) => value !== state.settings[key]);
    $('settings-reconnect').textContent = dirty ? t('保存并重连 ↗') : t('重新连接 ↗');
    $('settings-reconnect').title = dirty ? t('保存当前设置后重新连接引擎') : t('使用已保存的设置重新连接引擎');
  }

  async function savePreferences(forceReconnect = false) {
    if (state.savingSettings || state.configuring || state.selecting || state.sending) return;
    state.savingSettings = true; renderSelects(); renderComposerState();
    $('save-settings-button').disabled = true; $('settings-feedback').textContent = '';
    try {
      const patch = settingsPatch();
      if (!patch.executable) throw new Error(t('请选择 Grokbuild 的 Grok CLI 文件。'));
      if (!patch.workspace) throw new Error(t('请选择默认工作目录。'));
      const reconnectRequired = forceReconnect || ['executable', 'workspace', 'subagentsEnabled'].some(key => patch[key] !== state.settings[key]);
      if (reconnectRequired && state.busy.size) throw new Error(t('此设置需要重新连接引擎，请先停止正在执行的任务，再保存。'));
      for (const element of $('settings-form').querySelectorAll('input, select, button')) element.disabled = true;
      const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) => value !== state.settings[key]));
      const result = await call('saveSettings', changes);
      state.settings = { ...state.settings, ...patch, ...(result?.settings || result || {}) };
      renderWorkspace();
      if (reconnectRequired) { $('settings-feedback').textContent = t('设置已保存，正在重新连接…'); await reconnect(); }
      else toast(t('设置已保存。'));
      $('settings-dialog').close();
    } catch (error) { $('settings-feedback').textContent = error.message; if (!$('settings-dialog').open) toast(error.message, true, 7000); }
    finally {
      state.savingSettings = false;
      for (const element of $('settings-form').querySelectorAll('input, select, button')) element.disabled = false;
      updateSettingsReconnect(); renderSelects(); renderComposerState();
    }
  }

  async function reconnect() {
    if (state.connectionStatus === 'connecting') return;
    if (state.sending || state.configuring || state.selecting) { toast(t('请等待当前操作完成，再重新连接引擎。')); return; }
    if (state.busy.size) { toast(t('请先停止正在执行的任务，再重新连接引擎。')); return; }
    state.selecting = true;
    state.connectionStatus = 'connecting'; state.connected = false; state.lastError = ''; renderConnection();
    try {
      const result = await call('reconnect');
      state.info = normalizeInfo(result?.info || result || {});
      state.connected = result?.connected !== false;
      state.connectionStatus = state.connected ? 'ready' : 'disconnected';
      if (!state.connected) throw new Error(result?.error || t('引擎尚未连接，请检查设置。'));
      if (state.activeId) {
        const session = await call('selectSession', state.activeId);
        if (session?.id) upsertSession(session);
      }
      renderSelects(); renderWorkspace(); queueMessages(); toast(t('Grokbuild 已重新连接。'));
    } catch (error) { state.connected = false; state.connectionStatus = 'disconnected'; state.lastError = error.message; throw error; }
    finally { state.selecting = false; renderConnection(); }
  }

  async function exportSession(id) {
    if (!id) return;
    const result = await call('exportSession', id);
    if (result) toast(t('对话已导出：{path}', { path: typeof result === 'string' ? result : result.filePath || result.path || t('保存完成') }), false, 6000);
  }

  function installListeners() {
    $('account-button').addEventListener('click', () => guarded(async () => {
      if (document.querySelector('dialog[open]')) return;
      const result = await call('listAccounts');
      state.accounts = result.accounts; state.login = result.login;
      $('account-feedback').textContent = ''; renderAccounts(); $('accounts-dialog').showModal();
    }));
    $('account-login').addEventListener('click', () => { void accountWork(startAccountLogin); });
    $('add-account-form').addEventListener('submit', event => {
      event.preventDefault();
      if (accountsLocked()) return;
      const name = validateAccountName($('account-name-input'), 'account-feedback'); if (!name) return;
      void accountWork(async () => {
        const account = await call('addAccount', { name });
        $('account-name-input').value = ''; await changeAccount(account.id); await startAccountLogin();
      });
    });
    for (const id of ['account-name-input', 'account-rename-input', 'rename-input']) {
      $(id).addEventListener('input', () => { $(id).setCustomValidity(''); $(id).removeAttribute('aria-invalid'); });
      $(id).addEventListener('invalid', () => {
        if ($(id).validity.valueMissing) { $(id).setCustomValidity(id === 'rename-input' ? t('请输入对话标题。') : t('请输入账户名称。')); $(id).setAttribute('aria-invalid', 'true'); }
      });
    }
    $('account-rename-form').addEventListener('submit', event => {
      event.preventDefault();
      const name = validateAccountName($('account-rename-input'), 'account-rename-feedback'); if (!name) return;
      const id = state.accountRenameId; if (!id) return;
      void accountDialogWork('account-rename-dialog', 'account-rename-feedback', async () => {
        applyAccountSnapshot(await call('renameAccount', id, name));
        $('account-feedback').textContent = t('账户名称已保存。');
      });
    });
    $('account-delete-confirm').addEventListener('click', () => {
      const id = state.accountDeleteId; if (!id) return;
      const wasCurrent = id === state.activeAccountId;
      void accountDialogWork('account-delete-dialog', 'account-delete-feedback', async () => {
        applyAccountSnapshot(await call('deleteAccount', id));
        $('account-feedback').textContent = t('账户及其本地聊天记录已删除。') + (wasCurrent ? t('已返回默认账户。') : '') + (state.lastError ? ` ${state.lastError}` : '');
      });
    });
    for (const [dialogId, action, getId] of [
      ['account-rename-dialog', 'rename', () => state.accountRenameId],
      ['account-delete-dialog', 'delete', () => state.accountDeleteId],
    ]) $(dialogId).addEventListener('close', () => {
      const row = [...$('account-list').children].find(item => item.dataset.accountId === getId());
      const button = row?.querySelector(`[data-account-action="${action}"]`);
      if (button && !button.disabled) button.focus(); else $('account-login').focus();
    });
    $('account-cancel-login').addEventListener('click', () => guarded(async () => {
      if (!state.login || state.accountCancelPending) return;
      state.accountCancelPending = true; renderAccounts();
      try { await call('cancelAccountLogin'); }
      catch (error) { $('account-feedback').textContent = error.message || t('取消登录失败，请重试。'); }
      finally { state.accountCancelPending = false; renderAccounts(); }
    }));
    $('account-open-login').addEventListener('click', () => { if (state.login?.url) void guarded(() => call('openExternal', state.login.url)); });
    $('account-copy-code').addEventListener('click', () => guarded(async () => { if (state.login?.code) { await call('copyText', state.login.code); toast(t('验证码已复制。')); } }));
    $('image-dialog').addEventListener('close', () => $('image-preview').removeAttribute('src'));
    $('new-session').addEventListener('click', newChat);
    $('composer-form').addEventListener('submit', event => { event.preventDefault(); void sendMessage(); });
    $('attach-button').addEventListener('click', () => { void addAttachments(); });
    $('prompt').addEventListener('paste', event => {
      const files = [...(event.clipboardData?.files || [])];
      if (files.length) { event.preventDefault(); void addAttachments(files); }
    });
    const composer = $('composer-form');
    composer.addEventListener('dragover', event => {
      if ([...(event.dataTransfer?.types || [])].includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; composer.classList.add('drag-over'); }
    });
    composer.addEventListener('dragleave', event => { if (!composer.contains(event.relatedTarget)) composer.classList.remove('drag-over'); });
    composer.addEventListener('drop', event => {
      composer.classList.remove('drag-over');
      const files = [...(event.dataTransfer?.files || [])];
      if (files.length) { event.preventDefault(); void addAttachments(files); }
    });
    // Do not let dropping a file outside the composer navigate away from the app.
    for (const type of ['dragover', 'drop']) document.addEventListener(type, event => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); });
    $('prompt').addEventListener('input', () => { resizePrompt(); rememberDraft(); });
    $('prompt').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void sendMessage(); }
    });
    $('stop-button').addEventListener('click', () => guarded(async () => {
      const sessionId = state.activeId;
      $('stop-button').disabled = true;
      try { await call('cancel', sessionId); }
      finally { $('stop-button').disabled = false; }
    }));
    document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
      $('prompt').value = button.dataset.prompt; resizePrompt(); rememberDraft(); $('prompt').focus();
    }));
    $('model-select').addEventListener('change', () => {
      const model = $('model-select').value;
      if (activeSession()) { void guarded(() => configureSession({ model })); return; }
      const modelInfo = state.info.models.find(item => item.id === model);
      if (model !== state.info.currentModelId && !Array.isArray(modelInfo?.reasoningEfforts)) { void guarded(() => prepareModel(model)); return; }
      state.selectedModel = model; syncNewChatChoices(); renderSelects(); renderComposerState();
    });
    $('mode-select').addEventListener('change', () => {
      const mode = $('mode-select').value;
      if (activeSession()) { void guarded(() => configureSession({ mode })); return; }
      state.selectedMode = mode; renderSelects(); renderComposerState();
    });
    $('settings-button').addEventListener('click', showSettings);
    $('connection-button').addEventListener('click', () => guarded(reconnect));
    $('settings-reconnect').addEventListener('click', () => { void savePreferences(true); });
    $('settings-form').addEventListener('input', updateSettingsReconnect);
    for (const id of ['rain-input', 'music-input', 'music-volume']) $(id).addEventListener('input', applyAmbience);
    $('language-select').addEventListener('change', () => { applyLanguage($('language-select').value); updateSettingsReconnect(); });
    $('settings-dialog').addEventListener('close', () => { applyLanguage(state.settings.language); applyAmbience(); });
    const unlockMusic = () => { void ambience?.unlock(); };
    document.addEventListener('pointerdown', unlockMusic, { capture: true });
    document.addEventListener('keydown', unlockMusic, { capture: true });
    $('choose-executable').addEventListener('click', () => guarded(async () => { const result = await call('chooseExecutable', i18n.getLanguage()); if (result) { $('executable-input').value = result; updateSettingsReconnect(); } }));
    $('choose-workspace').addEventListener('click', () => guarded(async () => { const result = await call('chooseFolder', i18n.getLanguage()); if (result) { $('workspace-input').value = result; updateSettingsReconnect(); } }));
    $('workspace-button').addEventListener('click', () => guarded(async () => {
      if (state.savingSettings || state.sending || state.configuring || state.selecting || state.busy.size) return;
      state.savingSettings = true; renderSelects(); renderComposerState();
      try {
        const workspace = await call('chooseFolder', i18n.getLanguage()); if (!workspace || workspace === state.settings.workspace) return;
        const result = await call('saveSettings', { workspace });
        state.settings = { ...state.settings, workspace, ...(result?.settings || result || {}) };
        renderWorkspace();
        toast(activeSession() ? t('默认工作目录已更新，将用于新对话。') : t('工作空间已更新。'));
        await reconnect();
      } finally { state.savingSettings = false; renderSelects(); renderComposerState(); }
    }));
    $('settings-form').addEventListener('submit', event => {
      event.preventDefault();
      void savePreferences();
    });
    document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => $(button.dataset.closeDialog).close()));
    document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
      if (state.savingSettings || state.renaming || state.deleting || state.accountAction) return;
      if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); }
    }));
    document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('cancel', event => {
      if (state.savingSettings || state.renaming || state.deleting || state.accountAction) event.preventDefault();
    }));
    document.querySelectorAll('[data-window]').forEach(button => button.addEventListener('click', () => guarded(() => call('windowControl', button.dataset.window))));
    $('search-toggle').addEventListener('click', () => {
      searchVisible = !searchVisible; $('history-search').hidden = !searchVisible;
      if (searchVisible) $('session-search').focus(); else { $('session-search').value = ''; renderSessions(); }
    });
    $('session-search').addEventListener('input', renderSessions);
    $('session-search').addEventListener('keydown', event => { if (event.key === 'Escape') { $('session-search').value = ''; renderSessions(); searchVisible = false; $('history-search').hidden = true; } });
    $('export-button').addEventListener('click', () => guarded(() => exportSession(state.activeId)));
    $('menu-export').addEventListener('click', () => { const id = state.menuId; closeSessionMenu(); void guarded(() => exportSession(id)); });
    $('menu-rename').addEventListener('click', () => {
      state.renameId = state.menuId; const session = state.sessions.find(item => item.id === state.renameId); closeSessionMenu();
      if (!session) return;
      $('rename-input').value = sessionTitle(session); $('rename-input').setCustomValidity(''); $('rename-input').removeAttribute('aria-invalid');
      $('rename-dialog').showModal(); $('rename-input').select();
    });
    $('rename-form').addEventListener('submit', event => {
      event.preventDefault(); void guarded(async () => {
        if (state.renaming) return;
        const title = $('rename-input').value.trim();
        if (!title) { $('rename-input').setCustomValidity(t('请输入对话标题。')); $('rename-input').setAttribute('aria-invalid', 'true'); $('rename-input').reportValidity(); return; }
        const sessionId = state.renameId;
        state.renaming = true;
        for (const element of $('rename-form').querySelectorAll('input, button')) element.disabled = true;
        try {
          const result = await call('renameSession', { sessionId, title });
          if (result?.id) upsertSession(result); else { const session = state.sessions.find(item => item.id === sessionId); if (session) session.title = title; }
          $('rename-dialog').close(); renderSessions(); renderMessages();
        } finally { state.renaming = false; for (const element of $('rename-form').querySelectorAll('input, button')) element.disabled = false; }
      });
    });
    $('menu-delete').addEventListener('click', () => {
      state.deleteId = state.menuId; const session = state.sessions.find(item => item.id === state.deleteId); closeSessionMenu();
      if (!session) return;
      if (state.busy.has(session.id)) { toast(t('请先停止这段对话中的任务，再删除记录。')); return; }
      $('delete-title').textContent = sessionTitle(session); $('delete-dialog').showModal();
    });
    $('confirm-delete').addEventListener('click', () => guarded(async () => {
      const id = state.deleteId; if (!id || state.deleting) return;
      state.deleting = true;
      for (const element of $('delete-dialog').querySelectorAll('button')) element.disabled = true;
      try {
        await call('deleteSession', id);
        state.sessions = state.sessions.filter(session => session.id !== id); state.drafts.delete(id); clearPermissions(id); state.busy.delete(id);
        $('delete-dialog').close(); if (state.activeId === id) { newChat(); state.drafts.delete(id); } else renderSessions(); toast(t('对话已删除。'));
      } finally { state.deleting = false; for (const element of $('delete-dialog').querySelectorAll('button')) element.disabled = false; }
    }));
    document.addEventListener('click', event => {
      if (!$('session-menu').hidden && !$('session-menu').contains(event.target) && !event.target.closest('.session-more')) closeSessionMenu();
      const anchor = event.target.closest('.message-body a');
      if (anchor) {
        event.preventDefault();
        const url = anchor.getAttribute('href');
        const article = anchor.closest('.message');
        const message = activeSession()?.messages.find(item => item.id === article?.dataset.messageId);
        const attachment = message?.attachments?.find(item => item.src === url);
        if (attachment) {
          const card = [...article.querySelectorAll('.attachment-card')].find(item => item.dataset.attachmentId === attachment.id);
          card?.querySelector('.attachment-save')?.click();
        } else if (url && /^https?:\/\//i.test(url)) void guarded(() => call('openExternal', url));
        else toast(t('此链接不是网页地址，请在项目中查看对应文件。'));
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeSessionMenu();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); if (!document.querySelector('dialog[open]')) newChat(); }
      if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); showSettings(); }
    });
    unsubscribeMenu = api?.onMenuAction?.(action => {
      if (action === 'preferences') showSettings();
      else if (action === 'new-conversation' && !document.querySelector('dialog[open]')) newChat();
    });
    $('conversation-scroll').addEventListener('scroll', () => { $('scroll-bottom').hidden = !activeSession()?.messages.length || nearBottom(); });
    $('scroll-bottom').addEventListener('click', () => { $('conversation-scroll').scrollTop = $('conversation-scroll').scrollHeight; });
    const composerRegion = document.querySelector('.composer-region');
    const composerObserver = new ResizeObserver(() => { $('scroll-bottom').style.bottom = `${composerRegion.getBoundingClientRect().height + 8}px`; });
    composerObserver.observe(composerRegion);
    window.addEventListener('resize', closeSessionMenu);
    window.addEventListener('focus', updateClock);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) updateClock(); });
    window.addEventListener('beforeunload', () => { clearTimeout(clockTimer); composerObserver.disconnect(); if (typeof unsubscribe === 'function') unsubscribe(); unsubscribeMenu?.(); ambience?.dispose(); });
  }

  function applyLanguage(language) {
    const scrollTop = $('conversation-scroll').scrollTop;
    i18n.setLanguage(language); i18n.apply(document);
    renderWorkspace(); renderSessions(); renderMessages(); renderConnection(); renderAccounts();
    for (const element of document.querySelectorAll('#settings-feedback, #account-feedback, #account-rename-feedback, #account-delete-feedback, #toast-container .toast')) {
      element.textContent = diagnostic(element.textContent);
    }
    for (const input of document.querySelectorAll('input[aria-invalid="true"]')) {
      if (input.validity.customError) input.setCustomValidity(diagnostic(input.validationMessage));
    }
    updateSettingsReconnect(); updateClock();
    $('conversation-scroll').scrollTop = scrollTop;
  }

  function updateClock() {
    clearTimeout(clockTimer);
    const now = new Date();
    const label = now.toLocaleTimeString(i18n.getLanguage(), { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' JST';
    if ($('tokyo-time').textContent !== label) $('tokyo-time').textContent = label;
    // History and message times use the system timezone, while the location
    // clock above always represents Tokyo. Refresh after midnight or a zone change.
    const day = now.toDateString();
    const offset = now.getTimezoneOffset();
    if (clockDay !== undefined && (clockDay !== day || clockOffset !== offset)) renderSessions();
    if (clockOffset !== undefined && clockOffset !== offset) renderMessages();
    clockDay = day; clockOffset = offset;
    // Align to the system clock, including after sleep or a manual time change.
    clockTimer = setTimeout(updateClock, 1000 - Date.now() % 1000);
  }

  async function bootstrap() {
    i18n.apply(document);
    ambience = window.TokyoAmbience.create({ onStatus: renderMusicStatus });
    installListeners(); updateClock(); setInterval(updateActivity, 1000);
    renderConnection();
    try {
      if (api?.onEvent) unsubscribe = api.onEvent(onEvent);
      const result = await call('bootstrap');
      state.settings = { ...state.settings, ...(result?.settings || {}) };
      i18n.setLanguage(state.settings.language); i18n.apply(document);
      updateClock();
      state.info = normalizeInfo(result?.info || {});
      state.sessions = (result?.sessions || []).map(normalizeSession);
      state.accounts = result?.accounts || []; state.activeAccountId = result?.activeAccountId || 'local'; state.login = result?.login || null;
      state.connected = result?.connected === true;
      state.connectionStatus = state.connected ? 'ready' : 'disconnected';
      state.lastError = result?.error || '';
      state.initializing = false;
      syncNewChatChoices(true);
      renderWorkspace(); renderSessions(); renderSelects(); renderMessages(); renderConnection(); renderAccounts();
      if (state.lastError) toast(state.lastError, true, 9000);
    } catch (error) {
      state.initializing = false;
      state.connected = false; state.connectionStatus = 'disconnected'; state.lastError = error.message; renderConnection();
      toast(error.message, true, 10000);
    }
    resizePrompt(); $('prompt').focus();
  }

  void bootstrap();
})();
