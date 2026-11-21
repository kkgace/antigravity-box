// AntigravityBox — sandboxed preload bridge.
// Exposes a single invoke() surface; the renderer has no Node access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agbox', {
  invoke: (command, payload) => ipcRenderer.invoke('agbox:invoke', command, payload),
  openExternal: (url) => ipcRenderer.invoke('agbox:openExternal', url),
  revealPath: (p) => ipcRenderer.invoke('agbox:revealPath', p),
  theme: () => ipcRenderer.invoke('agbox:theme'),
  getAutostart: () => ipcRenderer.invoke('agbox:getAutostart'),
  setAutostart: (enabled) => ipcRenderer.invoke('agbox:setAutostart', enabled),
  openMainWindow: () => ipcRenderer.invoke('agbox:openMainWindow'),
  quitApp: () => ipcRenderer.invoke('agbox:quitApp'),
  // 用量 JSON 导出:主进程弹系统保存对话框后落盘;返回 { ok, canceled }。
  exportJson: (defaultName, content) => ipcRenderer.invoke('agbox:exportJson', defaultName, content),
  // HUD 引擎状态推送(主进程 → 渲染层单向广播;渲染层数据仍只经 invoke 拉取)。
  onHudStatus: (callback) => {
    const listener = (_event, status) => { try { callback(status); } catch { /* 渲染层异常不回流主进程 */ } };
    ipcRenderer.on('agbox:hud-status', listener);
    return () => ipcRenderer.removeListener('agbox:hud-status', listener);
  },
});
