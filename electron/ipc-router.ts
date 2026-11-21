/**
 * AntigravityBox — IPC command router.
 * Maps the gravitybox-compatible command surface onto the Backend service.
 * Every reply is either { ok: true, ...data } or { ok: false, error: sanitized }.
 */
import { app } from 'electron';
import { Backend } from './backend.js';
import { HudService } from './hud.js';
import { sanitizeError } from '../core/files.js';

type Handler = (payload: any) => Promise<Record<string, unknown>>;

function sanitize(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return sanitizeError(msg)
    .replace(/[A-Za-z]:\\(?:[^\\s'"]+\\)*[^\\s'"]+/g, '[路径]')
    .slice(0, 200);
}

export function createRouter(backend: Backend, hud?: HudService) {
  const handlers: Record<string, Handler> = {
    ping: async () => ({ pid: process.pid }),
    status: async (p) => backend.status(),
    dashboard_summary: async () => backend.dashboardSummary(),
    box_version: async () => ({ version: app.getVersion() }),

    account_list: async () => backend.accountList(),
    account_get: async (p) => {
      const acc = await backend.accountsManager.getAccount(String(p?.id ?? ''));
      return { ok: !!acc };
    },
    account_save_current: async () => {
      const account = await backend.accountsManager.saveCurrentAccount();
      return { account: { id: account.id, email: account.email, name: account.name ?? null } };
    },
    account_rename: async (p) => {
      const account = await backend.accountsManager.renameAccount(String(p?.id), String(p?.name ?? ''));
      return { id: account.id, name: account.name ?? null };
    },
    account_delete: async (p) => ({ removed: await backend.accountsManager.deleteAccount(String(p?.id)) }),
    account_reorder: async (p) => {
      const index = await backend.accountsManager.reorderAccounts(Array.isArray(p?.ids) ? p.ids.map(String) : []);
      return { order: index.accounts.map(a => a.id) };
    },

    quota_refresh: async (p) => {
      const id = String(p?.id ?? '');
      const updated = await backend.accountsManager.refreshQuota(id);
      void backend.recordQuotaSnapshot().catch(() => { /* 历史曲线尽力而为 */ });
      return { id: updated.id, refreshed: true };
    },
    quota_refresh_all: async () => {
      const result = await backend.accountsManager.refreshAllQuotas();
      void backend.recordQuotaSnapshot().catch(() => { /* 历史曲线尽力而为 */ });
      return result as unknown as Record<string, unknown>;
    },

    account_oauth_begin: async () => {
      const { id, url } = await backend.oauthLogin.begin();
      return { id, url };
    },
    account_oauth_status: async (p) => backend.oauthLogin.status(String(p?.id)) as unknown as Record<string, unknown>,
    account_oauth_cancel: async (p) => backend.oauthLogin.cancel(String(p?.id)) as unknown as Record<string, unknown>,

    usage_summary: async (p) => {
      const projected = await backend.usageSummary(p?.force === true, typeof p?.accountId === 'string' ? p.accountId : undefined);
      return { summary: projected };
    },
    usage_events: async (p) => {
      const events = await backend.usageEvents(
        String(p?.period ?? 'all'),
        typeof p?.query === 'string' ? p.query : '',
        Number(p?.offset ?? 0),
        Math.min(1000, Math.max(1, Number(p?.limit ?? 200))),
        typeof p?.accountId === 'string' ? p.accountId : undefined,
      );
      return { events };
    },
    usage_cancel: async () => ({ cancelled: backend.usageManager.cancelRead() }),
    usage_snapshot_release: async (p) => {
      backend.usageManager.releaseSnapshot(String(p?.id));
      return {};
    },
    usage_ledger_review: async () => ({ ledger: await backend.usageManager.ledgerReview() }),
    api_pricing_get: async () => backend.pricingTable(),

    // AntigravityBox 扩展 — 会话库浏览(只读,指标脱敏)。
    conversations_list: async () => backend.conversationOverview(),
    conversations_events: async (p) => ({ events: await backend.conversationEvents(String(p?.file ?? '')) }),

    // AntigravityBox 扩展 — 配额历史(总览页 24h/7d 曲线)。
    quota_history: async (p) => backend.quotaHistory(Number(p?.hours ?? 24)),
    quota_snapshot: async () => backend.recordQuotaSnapshot(),

    // AntigravityBox 扩展 — 个人词典层(写入后 HUD 词典经 fs.watch 自动重载)。
    dict_personal_get: async () => backend.personalDictionary(),
    dict_personal_save: async (p) => backend.savePersonalDictionary((p?.entries ?? {}) as Record<string, string>),

    update_check: async () => {
      const { checkForUpdate } = await import('./update.js');
      const cfg = await backend.config();
      return checkForUpdate(cfg.updateRepo, app.getVersion()) as unknown as Record<string, unknown>;
    },
    update_download: async () => {
      const { downloadAndVerifyUpdate } = await import('./update.js');
      const cfg = await backend.config();
      return downloadAndVerifyUpdate(cfg.updateRepo) as unknown as Record<string, unknown>;
    },
    update_install: async () => {
      const { installPendingUpdate } = await import('./update.js');
      return installPendingUpdate() as unknown as Record<string, unknown>;
    },

    account_switch_preflight: async () => {
      const { isApplicationRunning } = await import('../core/discovery.js');
      const running = await isApplicationRunning(backend.target.appPath);
      return { appRunning: running, switchSupported: backend.target.supportsAccountSwitch };
    },
    account_switch: async (p) => {
      const result = await backend.switchService.switchAccount(String(p?.id), p?.target === 'app' ? 'app' : 'all');
      return result as unknown as Record<string, unknown>;
    },
    account_switch_rollback: async () => backend.switchService.rollback() as unknown as Record<string, unknown>,
    account_recovery_info: async () => backend.switchService.recoveryInfo() as unknown as Record<string, unknown>,
    account_recovery_clear: async (p) => backend.switchService.clearRecovery(String(p?.digest ?? '')) as unknown as Record<string, unknown>,

    auto_switch_get: async () => ({ config: await backend.accountsManager.getAutoSwitchConfig() }),
    auto_switch_set: async (p) => ({ config: await backend.accountsManager.setAutoSwitchConfig(p?.config ?? {}) }),
    auto_switch_recommend: async () => backend.autoSwitchRecommend() as unknown as Record<string, unknown>,

    config_get: async () => backend.config(),
    config_set: async (p) => backend.savePreferences(p?.patch ?? {}),

    maintenance_scan: async (p) => backend.maintenanceScan({ retentionDays: p?.retentionDays }) as unknown as Record<string, unknown>,
    maintenance_history: async () => ({ history: await backend.maintenance.history() }),
    maintenance_clear: async (p) => backend.maintenanceClear(
      p?.token,
      Array.isArray(p?.names) && p.names.length > 0 ? p.names.map(String) : undefined,
    ) as unknown as Record<string, unknown>,
    maintenance_restore: async (p) => backend.maintenanceRestore(String(p?.snapshotId ?? '')) as unknown as Record<string, unknown>,

    set_application_channel: async () => ({
      applicationChannel: 'stable',
      applicationLabel: backend.target.label,
      accountSwitchSupported: backend.target.supportsAccountSwitch,
      bothApplicationsInstalled: false,
      availableChannels: ['stable'],
    }),

    // M2 — HUD / 汉化引擎(CDP 注入,零修改 Antigravity)。
    hud_status: async () => hud ? hud.status() : { mode: 'off', message: 'HUD 服务未启动', windows: 0 },
    reapply: async () => {
      if (!hud) throw new Error('HUD 服务未启动');
      return hud.reapply();
    },
    toggle: async () => {
      if (!hud) throw new Error('HUD 服务未启动');
      const status = await hud.status();
      return hud.setHudEnabled(status.hudEnabled !== true);
    },
    hud_set: async (p) => {
      if (!hud) throw new Error('HUD 服务未启动');
      return hud.setHudEnabled(p?.enabled === true);
    },
    language_set: async (p) => {
      if (!hud) throw new Error('HUD 服务未启动');
      return hud.setLanguage(String(p?.language ?? 'system'));
    },
    hud_safe_relaunch: async () => {
      // 渲染层已弹出确认对话框(用户确认保存工作后才会调用);此处执行上游 safeRelaunch 协议。
      const { safeRelaunchForDebug } = await import('../windows/lifecycle.js');
      const result = await safeRelaunchForDebug(backend.target.appPath);
      if (result.ok && hud) {
        // 重启完成后控制器经 DevToolsActivePort 文件监听自动重连;立即触发一次状态刷新。
        await hud.reapply().catch(() => {});
      }
      return result;
    },
  };

  return async function route(command: string, payload: any): Promise<Record<string, unknown>> {
    const handler = handlers[command];
    if (!handler) return { ok: false, error: `unknown command: ${command}` };
    try {
      const result = await handler(payload ?? {});
      return { ok: true, ...(result ?? {}) };
    } catch (error) {
      return { ok: false, error: sanitize(error) };
    }
  };
}
