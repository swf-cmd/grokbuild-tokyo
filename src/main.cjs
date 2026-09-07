const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createI18n, languages } = require('./i18n.js');
const { AppController } = require('./app-controller.cjs');
const { safeName } = require('./attachments.cjs');
const root = process.env.TOKYO_TEST_ROOT || (app.isPackaged ? path.resolve(path.dirname(process.execPath), '..') : path.resolve(__dirname, '..'));
app.setPath('userData', path.join(root, 'data', 'browser'));
app.setName('Grokbuild Tokyo');
app.setAppUserModelId('local.grokbuild.tokyo');
let win, controller, quitPending = false, quitAllowed = false;
const t = createI18n(() => controller?.settings.language);
const entry = path.join(__dirname, 'renderer', 'index.html');
const entryURL = pathToFileURL(entry).href;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(() => {
    controller = new AppController({ root, home: os.homedir() });
    win = new BrowserWindow({ width: 1440, height: 940, minWidth: 980, minHeight: 680, frame: false, show: false, backgroundColor: '#0b0e11', title: 'Grokbuild Tokyo', icon: path.join(__dirname, 'renderer', 'assets', 'icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
    Menu.setApplicationMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (url !== entryURL) event.preventDefault(); });
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    controller.on('event', payload => { if (win && !win.isDestroyed()) win.webContents.send('tokyo:event', payload); });
    const handle = (name, fn) => ipcMain.handle(`tokyo:${name}`, (event, ...args) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame?.url !== entryURL) throw new Error('Invalid IPC sender');
      return fn(...args);
    });
    for (const name of ['bootstrap', 'createSession', 'selectSession', 'configureSession', 'send', 'cancel', 'permission', 'saveSettings', 'renameSession', 'deleteSession', 'reconnect', 'listAccounts', 'addAccount', 'renameAccount', 'deleteAccount', 'switchAccount', 'loginAccount', 'cancelAccountLogin', 'readImage']) handle(name, (...args) => controller[name](...args));
    // Dialogs opened from settings follow its language preview without saving it.
    const dialogTranslator = language => typeof language === 'string' && Object.hasOwn(languages, language) ? createI18n(language) : t;
    handle('chooseFolder', async language => { const translate = dialogTranslator(language); const r = await dialog.showOpenDialog(win, { title: translate('选择 Grok 工作目录'), defaultPath: controller.settings.workspace, properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
    handle('chooseExecutable', async language => { const translate = dialogTranslator(language); const r = await dialog.showOpenDialog(win, { title: translate('选择 grok.exe'), defaultPath: controller.settings.executable, filters: [{ name: translate('Grok 可执行文件'), extensions: ['exe'] }], properties: ['openFile'] }); return r.canceled ? null : r.filePaths[0]; });
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
    win.on('close', event => { if (!quitAllowed) { event.preventDefault(); app.quit(); } });
    win.loadFile(entry);
  }).catch(error => { dialog.showErrorBox(t('Grokbuild Tokyo 启动失败'), error.message); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
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
