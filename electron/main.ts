/**
 * AntigravityBox — Electron entry point.
 * Creates the main console window, tray with quick panel, single-instance lock,
 * and routes renderer IPC to the ported core backend. Context isolation is on;
 * the renderer has zero Node capabilities.
 */
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeTheme, shell, dialog, globalShortcut } from 'electron';
import { join, dirname } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Backend } from './backend.js';
import { createRouter } from './ipc-router.js';
import { HudService } from './hud.js';
import { autoCheckIfDue } from './update.js';
import { checkQuotaThresholdNotification, notifyUpdateAvailable, type NotifyDeps } from './notifications.js';
import { defaultGeminiDir, stateDir } from '../windows/paths.js';
import { isApplicationRunning } from '../core/discovery.js';

const here = dirname(fileURLToPath(import.meta.url));
// 渲染层与代码同在 dist/(dev 树与 asar 打包后均为 <…>/dist/renderer);
// 此前用两层上级推导,在 asar 中会指向不存在的 app.asar/renderer。
const rendererRoot = join(here, '..', 'renderer');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let backend: Backend | null = null;
  let hud: HudService | null = null;
  let route: ((command: string, payload: any) => Promise<Record<string, unknown>>) | null = null;
  let mainWindow: BrowserWindow | null = null;
  let trayWindow: BrowserWindow | null = null;
  let tray: Tray | null = null;
  // Runtime preference effects (quota auto-refresh / follow Antigravity / update auto-check).
  let quotaTimer: ReturnType<typeof setInterval> | null = null;
  let followTimer: ReturnType<typeof setInterval> | null = null;
  let followArmed = false;
  let updateTimer: ReturnType<typeof setInterval> | null = null;
  let notifyTimer: ReturnType<typeof setInterval> | null = null;
  // 通知总开关:applyRuntimePreferences 在启动与偏好变更时刷新缓存
  let notifyEnabled = true;
  const notifyDeps: NotifyDeps = {
    enabled: () => notifyEnabled,
    onActivate: () => showMainWindow(),
  };

  function broadcastHudStatus(status: Record<string, unknown>) {
    for (const win of [mainWindow, trayWindow]) {
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('agbox:hud-status', status); } catch { /* 窗口正在销毁 */ }
      }
    }
  }

  function createMainWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1080,
      height: 720,
      minWidth: 880,
      minHeight: 600,
      show: false,
      title: 'AntigravityBox',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d23' : '#f3f4f8',
      webPreferences: {
        preload: join(here, '..', 'electron', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
      icon: join(rendererRoot, 'icon.png'),
      autoHideMenuBar: true,
    });
    win.setMenuBarVisibility(false);
    win.loadFile(join(rendererRoot, 'index.html'));
    win.once('ready-to-show', () => win.show());
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url);
      return { action: 'deny' };
    });
    return win;
  }

  function createTrayWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: 380,
      height: 520,
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'AntigravityBox 快捷面板',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d23' : '#f7f8fb',
      webPreferences: {
        preload: join(here, '..', 'electron', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.loadFile(join(rendererRoot, 'tray.html'));
    win.on('blur', () => { if (win.isVisible()) win.hide(); });
    return win;
  }

  function toggleTrayPanel() {
    if (!trayWindow) return;
    if (trayWindow.isVisible()) { trayWindow.hide(); return; }
    trayWindow.show();
    trayWindow.focus();
  }

  function showMainWindow() {
    if (!mainWindow) mainWindow = createMainWindow();
    mainWindow.show();
    mainWindow.focus();
  }

  function createTray() {
    try {
      tray = new Tray(join(rendererRoot, 'icon.png'));
    } catch {
      return; // icon missing — tray optional
    }
    tray.setToolTip('AntigravityBox');
    tray.on('click', () => toggleTrayPanel());
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开主界面', click: () => showMainWindow() },
      { label: '快捷面板', click: () => toggleTrayPanel() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
  }

  /** Apply preference-driven timers/watchers: quota auto-refresh, follow-Antigravity quit, update auto-check, theme, hotkey, notifications. */
  function applyRuntimePreferences(cfg: Awaited<ReturnType<Backend['config']>>) {
    if (quotaTimer) { clearInterval(quotaTimer); quotaTimer = null; }
    const minutes = Number(cfg.quotaRefreshIntervalMinutes ?? 0);
    if (minutes >= 1) {
      quotaTimer = setInterval(() => {
        void backend?.accountsManager.refreshAllQuotas().then(() => backend?.recordQuotaSnapshot().catch(() => { /* 历史曲线尽力而为 */ })).catch(() => { /* 刷新失败静默,下轮再试 */ });
      }, minutes * 60_000);
    }
    if (followTimer) { clearInterval(followTimer); followTimer = null; }
    followArmed = false;
    if (cfg.followAntigravity && backend) {
      followTimer = setInterval(() => {
        void (async () => {
          if (!backend) return;
          const running = await isApplicationRunning(backend.target.appPath).catch(() => false);
          if (running) followArmed = true;
          else if (followArmed) { followArmed = false; app.quit(); }
        })();
      }, 5000);
    }
    if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
    if (cfg.updateAutoCheck && backend) {
      const check = () => {
        void autoCheckIfDue(cfg.updateRepo, app.getVersion(), true)
          .then((result) => { if (result?.status === 'available' && result.latestVersion) notifyUpdateAvailable(notifyDeps, result.latestVersion); })
          .catch(() => { /* 自动检查不打扰 */ });
      };
      check();
      updateTimer = setInterval(check, 24 * 3600_000);
    }
    // 界面主题:system/light/dark → nativeTheme.themeSource(渲染层 prefers-color-scheme 随之生效)。
    nativeTheme.themeSource = cfg.themeMode === 'light' || cfg.themeMode === 'dark' ? cfg.themeMode : 'system';
    // 全局快捷键 Ctrl+Shift+B 呼出快捷面板。
    globalShortcut.unregister('Control+Shift+B');
    if (cfg.hotkeyEnabled !== false) {
      try { globalShortcut.register('Control+Shift+B', () => toggleTrayPanel()); } catch { /* 与其他应用冲突时放弃注册 */ }
    }
    // Windows 系统通知:配额阈值提醒(60s 巡检,内部有 30 分钟冷却)。
    notifyEnabled = cfg.notificationsEnabled !== false;
    if (notifyTimer) { clearInterval(notifyTimer); notifyTimer = null; }
    if (notifyEnabled && backend) {
      notifyTimer = setInterval(() => {
        void checkQuotaThresholdNotification(backend!, notifyDeps).catch(() => { /* 下轮再试 */ });
      }, 60_000);
    }
  }

  app.on('second-instance', () => {
    if (!mainWindow) mainWindow = createMainWindow();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    backend = new Backend();

    ipcMain.handle('agbox:invoke', async (_event, command: unknown, payload: unknown) => {
      if (typeof command !== 'string') return { ok: false, error: 'invalid command' };
      if (!route) return { ok: false, error: 'backend not ready' };
      return route(command, payload);
    });
    ipcMain.handle('agbox:openExternal', async (_event, url: unknown) => {
      if (typeof url === 'string' && /^https:\/\//.test(url)) await shell.openExternal(url);
      return { ok: true };
    });
    ipcMain.handle('agbox:revealPath', async (_event, targetPath: unknown) => {
      if (typeof targetPath !== 'string') return { ok: false };
      await shell.openPath(targetPath);
      return { ok: true };
    });
    ipcMain.handle('agbox:theme', () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    ipcMain.handle('agbox:getAutostart', () => app.getLoginItemSettings().openAtLogin);
    ipcMain.handle('agbox:setAutostart', (_e, enabled: unknown) => {
      app.setLoginItemSettings({ openAtLogin: enabled === true });
      return { openAtLogin: enabled === true };
    });
    ipcMain.handle('agbox:openMainWindow', () => { showMainWindow(); return { ok: true }; });
    ipcMain.handle('agbox:quitApp', () => { app.quit(); return { ok: true }; });
    // 用量 JSON/CSV/Markdown 导出:渲染层没有 Node 能力,由主进程弹保存对话框并落盘。
    ipcMain.handle('agbox:exportJson', async (_e, defaultName: unknown, content: unknown, filter: unknown) => {
      if (typeof defaultName !== 'string' || typeof content !== 'string') return { ok: false, error: 'invalid export payload' };
      const target = mainWindow && mainWindow.isVisible() ? mainWindow : (mainWindow ?? trayWindow);
      if (!target) return { ok: false, error: 'no window' };
      const safeFilter = filter && typeof filter === 'object'
        ? (filter as { name?: unknown; extensions?: unknown[] })
        : null;
      const filters = safeFilter && typeof safeFilter.name === 'string' && Array.isArray(safeFilter.extensions)
        ? [{ name: safeFilter.name, extensions: safeFilter.extensions.filter(x => typeof x === 'string') as string[] }]
        : [{ name: 'JSON', extensions: ['json'] }];
      const result = await dialog.showSaveDialog(target, {
        defaultPath: defaultName,
        filters,
      });
      if (result.canceled || !result.filePath) return { ok: true, canceled: true };
      await writeFile(result.filePath, content, 'utf8');
      return { ok: true, canceled: false };
    });

    // 应用菜单只承担快捷键(Ctrl+, 打开主界面 / Ctrl+Q 退出);菜单栏本身保持隐藏。
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: 'AntigravityBox',
        submenu: [
          { label: '打开主界面', accelerator: 'CmdOrCtrl+,', click: () => showMainWindow() },
          { type: 'separator' },
          { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
        ],
      },
    ]));

    mainWindow = createMainWindow();
    trayWindow = createTrayWindow();
    createTray();

    // HUD / 汉化引擎:随应用启动,状态变更实时广播到主窗口与托盘。
    hud = new HudService(
      backend.target.appPath,
      backend.target.profile,
      defaultGeminiDir(),
      stateDir(),
      broadcastHudStatus,
    );
    route = createRouter(backend, hud);
    // 偏好变更(配额刷新间隔/跟随启停/自动检查更新)即时作用到壳层定时器。
    backend.onRuntimePreferencesChanged = () => {
      void backend!.config().then(applyRuntimePreferences).catch(() => { /* 配置读取失败保持现状 */ });
    };
    void backend.config().then(applyRuntimePreferences).catch(() => { /* 首次启动读取失败则全部保持默认 */ });
    // 启动后延迟落一份配额快照(等账号索引与凭据就绪),供 24h/7d 曲线起始点使用。
    setTimeout(() => { void backend?.recordQuotaSnapshot().catch(() => { /* 历史曲线尽力而为 */ }); }, 4000);
    void hud.start().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[AntigravityBox] HUD 引擎启动失败:', message);
    });
  });

  app.on('window-all-closed', () => {
    // Tray app convention on Windows: stay alive when the console window closes.
    if (tray === null) app.quit();
  });

  app.on('before-quit', () => {
    if (notifyTimer) { clearInterval(notifyTimer); notifyTimer = null; }
    globalShortcut.unregisterAll();
    void backend?.oauthLogin.close();
    void hud?.stop();
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[AntigravityBox]', reason instanceof Error ? reason.message : reason);
  });
}
