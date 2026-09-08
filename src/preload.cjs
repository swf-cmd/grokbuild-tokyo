const { contextBridge, ipcRenderer } = require('electron');
const invoke = name => (...args) => ipcRenderer.invoke(`tokyo:${name}`, ...args);
contextBridge.exposeInMainWorld('tokyo', {
  platform: process.platform,
  onMenuAction: callback => { const listener = (_event, action) => { if (['preferences', 'new-conversation'].includes(action)) callback(action); }; ipcRenderer.on('tokyo:menu', listener); return () => ipcRenderer.removeListener('tokyo:menu', listener); },
  bootstrap: invoke('bootstrap'), createSession: invoke('createSession'), selectSession: invoke('selectSession'),
  configureSession: invoke('configureSession'),
  chooseAttachments: invoke('chooseAttachments'), importAttachments: invoke('importAttachments'), saveAttachment: invoke('saveAttachment'),
  readImage: invoke('readImage'), listAccounts: invoke('listAccounts'), addAccount: invoke('addAccount'), renameAccount: invoke('renameAccount'), deleteAccount: invoke('deleteAccount'), switchAccount: invoke('switchAccount'), loginAccount: invoke('loginAccount'), cancelAccountLogin: invoke('cancelAccountLogin'),
  send: invoke('send'), cancel: invoke('cancel'), permission: invoke('permission'),
  saveSettings: invoke('saveSettings'), chooseFolder: invoke('chooseFolder'), chooseExecutable: invoke('chooseExecutable'),
  renameSession: invoke('renameSession'), deleteSession: invoke('deleteSession'), exportSession: invoke('exportSession'),
  reconnect: invoke('reconnect'), windowControl: invoke('windowControl'), openExternal: invoke('openExternal'), copyText: invoke('copyText'),
  onEvent: callback => { const listener = (_event, payload) => callback(payload); ipcRenderer.on('tokyo:event', listener); return () => ipcRenderer.removeListener('tokyo:event', listener); }
});
