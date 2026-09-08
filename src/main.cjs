const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createI18n, languages } = require('./i18n.js');
const { AppController } = require('./app-controller.cjs');
const { safeName } = require('./attachments.cjs');
const { appRoot } = require('./app-paths.cjs');
const isMac = process.platform === 'darwin';
const root = appRoot({ testRoot: process.env.TOKYO_TEST_ROOT, appData: app.getPath('appData'), isPackaged: app.isPackaged, executablePath: process.execPath, sourceRoot: path.resolve(__dirname, '..') });
fs.mkdirSync(path.join(root, 'data', 'browser'), { recursive: true });
app.setPath('userData', path.join(root, 'data', 'browser'));
app.setName('Grokbuild Tokyo');
if (process.platform === 'win32') app.setAppUserModelId('local.grokbuild.tokyo');
let win, controller, quitPending = false, quitAllowed = false;
const t = createI18n(() => controller?.settings.language);
const entry = path.join(__dirname, 'renderer', 'index.html');
const entryURL = pathToFileURL(entry).href;
const showWindow = () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } };
const menuAction = action => { showWindow(); win?.webContents.send('tokyo:menu', action); };
function installMenu() {
  if (!isMac) { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [
      { role: 'about' }, { type: 'separator' },
      { id: 'preferences', label: t('偏好设置'), accelerator: 'Cmd+,', click: () => menuAction('preferences') },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'fileMenu', submenu: [
      { id: 'new-conversation', label: t('开启新对话'), accelerator: 'Cmd+N', click: () => menuAction('new-conversation') },
      { type: 'separator' }, { role: 'close' },
    ] },
    { role: 'editMenu' }, { role: 'viewMenu', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.whenReady().then(() => {
    controller = new AppController({ root, home: os.homedir() });
    win = new BrowserWindow({ width: 1440, height: 940, minWidth: 980, minHeight: 680, frame: isMac, ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 14 } } : {}), show: false, backgroundColor: '#0b0e11', title: 'Grokbuild Tokyo', icon: path.join(__dirname, 'renderer', 'assets', 'icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
    installMenu();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (url !== entryURL) event.preventDefault(); });
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    controller.on('event', payload => { if (win && !win.isDestroyed()) win.webContents.send('tokyo:event', payload); });
    const handle = (name, fn) => ipcMain.handle(`tokyo:${name}`, (event, ...args) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame?.url !== entryURL) throw new Error('Invalid IPC sender');
      return fn(...args);
    });
    for (const name of ['bootstrap', 'createSession', 'selectSession', 'configureSession', 'send', 'cancel', 'permission', 'renameSession', 'deleteSession', 'reconnect', 'listAccounts', 'addAccount', 'renameAccount', 'deleteAccount', 'switchAccount', 'loginAccount', 'cancelAccountLogin', 'readImage']) handle(name, (...args) => controller[name](...args));
    handle('saveSettings', async patch => { const result = await controller.saveSettings(patch); installMenu(); return result; });
    // Dialogs opened from settings follow its language preview without saving it.
    const dialogTranslator = language => typeof language === 'string' && Object.hasOwn(languages, language) ? createI18n(language) : t;
    handle('chooseFolder', async language => { const translate = dialogTranslator(language); const r = await dialog.showOpenDialog(win, { title: translate('选择 Grok 工作目录'), defaultPath: controller.settings.workspace, properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
    handle('chooseExecutable', async language => { const translate = dialogTranslator(language); const r = await dialog.showOpenDialog(win, { title: translate('选择 Grok CLI'), defaultPath: controller.settings.executable, ...(process.platform === 'win32' ? { filters: [{ name: translate('Grok 可执行文件'), extensions: ['exe'] }] } : {}), properties: ['openFile', 'showHiddenFiles'] }); return r.canceled ? null : r.filePaths[0]; });
    handle('chooseAttachments', async ({ language, accountId = controller.activeAccountId } = {}) => {
      if (controller.activeAccountId !== accountId) throw new Error(t('附件已失效，请重新添加'));
      const result = await dialog.showOpenDialog(win, { title: dialogTranslator(language)('选择图片或附件'), properties: ['openFile', 'multiSelections'] });
      if (result.canceled) return [];
      if (controller.activeAccountId !== accountId) throw new Error(t('附件已失效，请重新添加'));
      return controller.importAttachments({ files: result.filePaths, accountId }, true);
    });
    handle('importAttachments', payload => controller.importAttachments(payload));
    handle('saveAttachment', async args => {
      const { attachment } = controller.getAttachment(args);
      const accountId = controller.activeAccountId;
      const result = await dialog.showSaveDialog(win, { title: t('保存附件'), defaultPath: safeName(attachment.fileName || attachment.name) });
      if (result.canceled || !result.filePath) return { canceled: true };
      if (controller.activeAccountId !== accountId) throw new Error(t('附件已失效，请重新添加'));
      const bytes = await controller.attachmentBytes(args);
      await fs.promises.writeFile(result.filePath, bytes);
      return { canceled: false, path: result.filePath };
    });
    handle('exportSession', async id => {
      const s = controller.getSession(id);
      const title = controller.sessionTitle(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
      const markdown = controller.exportMarkdown(id);
      const result = await dialog.showSaveDialog(win, { title: t('导出会话'), defaultPath: path.join(root, `${title}.md`), filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (result.canceled || !result.filePath) return null;
      fs.writeFileSync(result.filePath, markdown, 'utf8'); return result.filePath;
    });
    handle('windowControl', action => { if (action === 'minimize') win.minimize(); else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize(); else if (action === 'close') win.close(); });
    handle('openExternal', async url => { const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error(t('不支持的链接')); return shell.openExternal(parsed.href); });
    handle('copyText', async text => { if (typeof text !== 'string' || text.length > 2000000) throw new Error(t('无法复制这段内容')); await clipboard.writeText(text); return true; });
    win.once('ready-to-show', () => win.show());
    win.on('close', event => { if (!quitAllowed) { event.preventDefault(); if (isMac && !quitPending) win.hide(); else app.quit(); } });
    win.loadFile(entry);
  }).catch(error => { dialog.showErrorBox(t('Grokbuild Tokyo 启动失败'), error.message); app.exit(1); });
  app.on('window-all-closed', () => { if (!isMac) app.quit(); });
  app.on('before-quit', event => {
    if (quitAllowed || !controller) return;
    event.preventDefault();
    if (quitPending) return;
    quitPending = true;
    controller.close()
      .then(() => { quitAllowed = true; app.quit(); })
      .catch(error => { quitPending = false; dialog.showErrorBox(t('关闭 Grokbuild Tokyo 时出错'), error.message); });
  });
}
