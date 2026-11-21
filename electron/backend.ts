/**
 * AntigravityBox — backend orchestration service.
 * Counterpart of gravitybox's src/main.ts UDS server: instantiates the ported core
 * managers and exposes the same command surface (45 commands) to the UI layer.
 * Runs inside the Electron main process; credentials never cross the IPC boundary.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readOptionalJson, atomicJson, sanitizeError } from '../core/files.js';
import { appendQuotaSnapshot, readQuotaHistory } from '../core/quota-history.js';
import { readPersonalDictionary, writePersonalDictionary, personalDictionaryPath } from '../core/dictionary.js';
import { applicationTarget, detectInstalledChannels, probeBundleCapabilities, type ApplicationTarget } from '../core/application-target.js';
import { savedApplicationChannel, applicationChannel } from '../core/application-target.js';
import { AccountsManager } from '../core/accounts.js';
import { AccountSwitchService } from '../core/account-switch.js';
import { UsageStatsManager } from '../core/usage.js';
import { CacheMaintenance } from '../core/maintenance.js';
import { GoogleAccountLogin } from '../core/account-oauth.js';
import { getGoogleClientId, getGoogleClientSecret } from '../core/accounts.js';
import {
  projectAccountForIpcNormalized,
  normalizeSubscriptionTier,
} from '../core/ipc-projections.js';
import { bt } from '../core/i18n.js';
import { stateDir as platformStateDir, defaultGeminiDir, cacheDir } from '../windows/paths.js';
import type { Account } from '../core/accounts.js';
import type { QuotaData } from '../core/account-quota.js';

function formatResetTime(resetTime: number | null | undefined): string {
  if (!resetTime) return '';
  const tsMs = typeof resetTime === 'number' && resetTime < 1e11 ? resetTime * 1000 : Number(resetTime);
  const date = new Date(tsMs);
  return !isNaN(date.getTime())
    ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    : String(resetTime);
}

/** Merge live language-server quota with saved account quota (semantics from gravitybox main.ts). */
function mergeLiveQuotaWithSaved(
  savedQuota: QuotaData | null | undefined,
  liveQuota: QuotaData | null | undefined,
): QuotaData | null | undefined {
  if (!liveQuota) return savedQuota;
  if (!savedQuota) return liveQuota;
  const hasLiveGroups = Array.isArray(liveQuota.quota_groups) && liveQuota.quota_groups.length > 0;
  const hasKnownLiveModels = Array.isArray(liveQuota.models) && liveQuota.models.some(m => m?.percentage_known || m?.own_percentage_known);
  const hasSavedModels = Array.isArray(savedQuota.models) && savedQuota.models.length > 0;
  const liveComplete = liveQuota.refresh_state?.complete === true;
  const mergedStaleGroups = liveQuota.stale_groups?.length
    ? liveQuota.stale_groups
    : (hasLiveGroups && liveComplete ? undefined : savedQuota.stale_groups);
  const merged: QuotaData = {
    ...savedQuota,
    ...liveQuota,
    quota_groups: hasLiveGroups ? liveQuota.quota_groups : (savedQuota.quota_groups ?? []),
    models: (hasLiveGroups || hasKnownLiveModels || !hasSavedModels) ? liveQuota.models : savedQuota.models,
    subscription_tier: liveQuota.subscription_tier && liveQuota.subscription_tier !== 'FREE'
      ? liveQuota.subscription_tier
      : (savedQuota.subscription_tier ?? liveQuota.subscription_tier),
  };
  if (mergedStaleGroups?.length) merged.stale_groups = mergedStaleGroups;
  return merged;
}

function sanitizeErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  const redacted = sanitizeError(msg);
  // Windows path tokenization (counterpart of the /Users|/private|/var sanitizer).
  return redacted
    .replace(/[A-Za-z]:\\(?:[^\\s'"]+\\)*[^\\s'"]+/g, bt('common.path_token'))
    .slice(0, 200);
}

export interface BackendOptions {
  stateDir?: string;
  geminiDir?: string;
  appPath?: string;
  profile?: string;
}

export class Backend {
  readonly stateDir: string;
  readonly geminiDir: string;
  target: ApplicationTarget;
  channel: 'stable' = 'stable';
  accountsManager: AccountsManager;
  usageManager: UsageStatsManager;
  switchService: AccountSwitchService;
  maintenance: CacheMaintenance;
  oauthLogin: GoogleAccountLogin;
  private probeCache: { at: number; value: Awaited<ReturnType<AccountsManager['probeLiveLanguageServer']>> } | null = null;
  private startedAt = Date.now();
  private cachedAppVersion: string | null = null;

  /** Detected Antigravity version (probed once; empty when the bundle is unavailable). */
  get appVersion(): string {
    if (this.cachedAppVersion === null) {
      try { this.cachedAppVersion = probeBundleCapabilities(this.target.appPath)?.version ?? ''; }
      catch { this.cachedAppVersion = ''; }
    }
    return this.cachedAppVersion;
  }

  constructor(options: BackendOptions = {}) {
    this.stateDir = options.stateDir ?? platformStateDir();
    this.geminiDir = options.geminiDir ?? process.env.ANTIGRAVITYBOX_GEMINI_DIR ?? defaultGeminiDir();
    this.target = applicationTarget('stable', homedir(), {
      appPath: options.appPath,
      profile: options.profile,
    });
    this.accountsManager = new AccountsManager(this.stateDir, { target: this.target });
    this.usageManager = new UsageStatsManager({
      stateDir: this.stateDir,
      geminiDir: this.geminiDir,
      dataDirectoryName: this.target.dataDirectoryName,
    });
    this.switchService = new AccountSwitchService(this.accountsManager, {
      stateDir: this.stateDir,
      profile: this.target.profile,
      target: this.target,
    });
    this.maintenance = new CacheMaintenance(
      this.target.profile,
      join(cacheDir(), 'maintenance-trash'),
      undefined,
      { stateDir: this.stateDir, geminiDir: this.geminiDir, appPath: this.target.appPath },
    );
    this.oauthLogin = new GoogleAccountLogin((token, signal) => this.accountsManager.addAccountFromOAuth(token, signal));
  }

  /** Probe the live language server with a short-TTL cache (matches gravitybox probeLiveCached). */
  async probeLiveCached(force = false) {
    const now = Date.now();
    if (!force && this.probeCache && now - this.probeCache.at < 4500) return this.probeCache.value;
    const value = await this.accountsManager.probeLiveLanguageServer().catch(() => null);
    this.probeCache = { at: now, value };
    return value;
  }

  async syncAccountContextToUsage() {
    try {
      const live = await this.probeLiveCached().catch(() => null);
      const listRes = await this.accountsManager.listAccounts({ liveEmailHint: live?.email ?? null }).catch(() => null);
      if (listRes?.accounts) {
        this.usageManager.setKnownAccounts(listRes.accounts.map(a => ({ id: a.id, email: a.email, name: a.name ?? null })));
      }
      const observedEmail = typeof live?.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(live.email) ? live.email : null;
      if (observedEmail) {
        const matched = listRes?.accounts.find(account => account.email.toLowerCase() === observedEmail.toLowerCase());
        this.usageManager.setCurrentAccountContext({ id: matched?.id ?? observedEmail, email: observedEmail });
      } else {
        this.usageManager.setCurrentAccountContext(undefined);
      }
    } catch { /* usage attribution is best-effort */ }
  }

  async accountList() {
    const index = await this.accountsManager.loadIndex();
    const listNowMs = Date.now();
    const live = await this.probeLiveCached().catch(() => null);
    const detectedEmail = live?.email ?? await this.accountsManager.detectCurrentAntigravityEmail({ liveEmailHint: null }).catch(() => null);
    let effectiveActiveId = index.current_account_id;
    if (detectedEmail) {
      const matched = index.accounts.find(a => a.email.toLowerCase() === detectedEmail.toLowerCase());
      effectiveActiveId = matched?.id ?? null;
    }
    const accountsWithQuota = await Promise.all(index.accounts.map(async (summary): Promise<Record<string, unknown> & { id: string }> => {
      let saved;
      try { saved = await this.accountsManager.getAccount(summary.id); }
      catch {
        return { id: summary.id, email: summary.email, name: summary.name, disabled: true,
          validation_blocked: true, quota: null, quota_refresh_error: bt('main.account_unreadable'),
          credentialReadiness: { state: 'needs_authorization', message: bt('main.account_check_files') } };
      }
      if (!saved) {
        return { id: summary.id, email: summary.email, name: summary.name, disabled: true,
          quota: null, quota_refresh_error: bt('main.account_missing'),
          credentialReadiness: { state: 'needs_authorization', message: bt('main.account_check_files') } };
      }
      const isLiveMatched = live?.email?.toLowerCase() === summary.email.toLowerCase() && live.quota;
      const acc: Account = {
        ...saved,
        quota: isLiveMatched ? mergeLiveQuotaWithSaved(saved.quota, live.quota) : saved.quota,
      };
      const projected = projectAccountForIpcNormalized(acc, this.accountsManager, {
        nowMs: listNowMs,
        includeOverviewFields: true,
        formatResetTime,
        revisionWithReadiness: true,
      });
      return { id: acc.id, ...(projected ?? {}) };
    }));
    accountsWithQuota.sort((a, b) => {
      const aActive = a.id === effectiveActiveId ? 1 : 0;
      const bActive = b.id === effectiveActiveId ? 1 : 0;
      return bActive - aActive;
    });
    const recovery = await this.switchService.recoveryInfo().catch(() => ({ available: true, pending: true, status: 'unreadable' }));
    return {
      activeId: effectiveActiveId,
      currentAccountId: effectiveActiveId,
      identityState: live?.email ? 'verified' : 'configured',
      accounts: accountsWithQuota,
      targetIde: index.current_target_ide,
      recovery,
    };
  }

  async status() {
    let activeAccountEmail = '';
    let activeFiveHourQuota: number | null = null;
    let activeSubscriptionTier = 'FREE';
    let liveAccountEmail: string | null = null;
    let accountsRevision = '';
    try {
      const liveLs = await this.probeLiveCached();
      const listRes = await this.accountsManager.listAccounts({ liveEmailHint: liveLs?.email ?? null });
      accountsRevision = listRes.revision;
      this.usageManager.setKnownAccounts(listRes.accounts.map(a => ({ id: a.id, email: a.email, name: a.name ?? null })));
      const detectedEmail = liveLs?.email ?? await this.accountsManager.detectCurrentAntigravityEmail({ liveEmailHint: null }).catch(() => null);
      if (detectedEmail) {
        liveAccountEmail = liveLs?.email ?? null;
        const matchedSummary = listRes.accounts.find(a => a.email.toLowerCase() === detectedEmail.toLowerCase());
        if (liveLs?.email) {
          this.usageManager.setCurrentAccountContext({ id: matchedSummary?.id ?? liveLs.email, email: liveLs.email });
        }
        const matchedSaved = matchedSummary ? await this.accountsManager.getAccount(matchedSummary.id) : null;
        if (matchedSaved) {
          activeAccountEmail = matchedSaved.email;
          const liveQuotaForMatched = liveLs?.email?.toLowerCase() === detectedEmail.toLowerCase() ? liveLs.quota : null;
          const q = this.accountsManager.getAccountQuotaOverview({ ...matchedSaved, quota: mergeLiveQuotaWithSaved(matchedSaved.quota, liveQuotaForMatched) });
          activeFiveHourQuota = q.fiveHourRemaining;
          activeSubscriptionTier = normalizeSubscriptionTier(q.subscriptionTier);
        } else if (liveLs?.email) {
          activeAccountEmail = liveLs.email;
          const q = this.accountsManager.getAccountQuotaOverview({ quota: liveLs.quota });
          activeFiveHourQuota = q.fiveHourRemaining;
          activeSubscriptionTier = normalizeSubscriptionTier((liveLs.tier && !/starter|free/i.test(liveLs.tier)) ? liveLs.tier : (q.subscriptionTier !== 'FREE' ? q.subscriptionTier : bt('quota.tier.pending')));
        }
      } else if (listRes.active_account) {
        activeAccountEmail = listRes.active_account.email;
        const q = this.accountsManager.getAccountQuotaOverview(listRes.active_account);
        activeFiveHourQuota = q.fiveHourRemaining;
        activeSubscriptionTier = normalizeSubscriptionTier(q.subscriptionTier);
      }
    } catch { /* degraded status is still a status */ }
    const installState = detectInstalledChannels(this.channel);
    const bundleCaps = (() => {
      try {
        // 本文件以 ESM 运行:不能用 require(会 ReferenceError → 被吞掉 → appVersion 恒空),
        // 必须静态导入。
        return probeBundleCapabilities(this.target.appPath);
      } catch { return null; }
    })();
    return {
      status: {
        schema: 1,
        mode: 'ready',
        message: '',
        appVersion: bundleCaps?.version ?? '',
        appArchitecture: bundleCaps?.architecture ?? 'wcv-hub',
        legacyPatchDetected: false,
        startedAt: this.startedAt,
        oauthClientConfigured: Boolean(getGoogleClientId() && getGoogleClientSecret()),
        applicationChannel: this.channel,
        applicationLabel: this.target.label,
        accountSwitchSupported: this.target.supportsAccountSwitch,
        bothApplicationsInstalled: installState.bothInstalled,
        availableChannels: installState.channels,
        appPath: this.target.appPath,
        profile: this.target.profile,
        geminiDir: this.geminiDir,
        stateDir: this.stateDir,
        activeAccountEmail,
        activeFiveHourQuota,
        activeSubscriptionTier,
        liveAccountEmail,
        accountsRevision,
        hudEnabled: false,
        translationEnabled: false,
        hudSupported: false,
      },
    };
  }

  async usageSummary(forceRefresh = false, accountId?: string) {
    await this.syncAccountContextToUsage();
    const summary = await this.usageManager.getUsageSummary(forceRefresh, accountId);
    return projectAccountUsage(summary);
  }

  async usageEvents(period: string, query = '', offset = 0, limit = 200, accountId?: string) {
    await this.syncAccountContextToUsage();
    return this.usageManager.getUsageEvents(period, query, offset, limit, undefined, false, false, accountId);
  }

  async pricingTable() {
    const table = await this.usageManager.getActivePricingTable();
    return { count: Object.keys(table).length };
  }

  async config() {
    const configured = await readOptionalJson<{ language?: string; hudEnabled?: boolean; translationEnabled?: boolean;
      quotaRefreshIntervalMinutes?: number; followAntigravity?: boolean; updateAutoCheck?: boolean; updateRepo?: string;
      themeMode?: string; notificationsEnabled?: boolean; hotkeyEnabled?: boolean }>(
      join(this.stateDir, 'runtime-preferences.json'), 'runtime-preferences.json');
    const autoSwitch = await this.accountsManager.getAutoSwitchConfig().catch(() => null);
    const pricePrefs = await readOptionalJson<{ enabled?: boolean }>(join(this.stateDir, 'pricing-preferences.json'), 'pricing-preferences.json');
    return {
      language: configured?.language ?? 'system',
      hudEnabled: configured?.hudEnabled ?? true,
      translationEnabled: configured?.translationEnabled ?? true,
      // 配额自动刷新间隔(分钟);0 = 手动刷新。
      quotaRefreshIntervalMinutes: Number.isFinite(configured?.quotaRefreshIntervalMinutes) ? Number(configured?.quotaRefreshIntervalMinutes) : 0,
      // 跟随 Antigravity 启停:检测到 Antigravity 退出后自动退出本应用。
      followAntigravity: configured?.followAntigravity === true,
      // 检查更新(GitHub Releases);SHA-256 校验后提示安装。默认指向本项目仓库,开箱即用。
      updateAutoCheck: configured?.updateAutoCheck === true,
      updateRepo: typeof configured?.updateRepo === 'string' && configured.updateRepo.trim() ? configured.updateRepo : 'kkgace/antigravity-box',
      // 界面主题:system(跟随系统)/ light / dark —— 落到 nativeTheme.themeSource。
      themeMode: configured?.themeMode === 'light' || configured?.themeMode === 'dark' ? configured.themeMode : 'system',
      // Windows 系统通知(配额阈值提醒 / 更新提醒)。
      notificationsEnabled: configured?.notificationsEnabled !== false,
      // 全局快捷键 Ctrl+Shift+B 呼出快捷面板。
      hotkeyEnabled: configured?.hotkeyEnabled !== false,
      autoSwitch,
      autoRemotePricingSync: pricePrefs?.enabled === true,
      oauthClientConfigured: Boolean(getGoogleClientId() && getGoogleClientSecret()),
    };
  }

  /** Preference keys whose runtime effects (timers/watchers) live in the electron shell. */
  static readonly RUNTIME_PREF_KEYS = ['quotaRefreshIntervalMinutes', 'followAntigravity', 'updateAutoCheck', 'updateRepo', 'themeMode', 'notificationsEnabled', 'hotkeyEnabled'] as const;
  onRuntimePreferencesChanged: (() => void) | null = null;

  async savePreferences(patch: Record<string, unknown>) {
    const current = await readOptionalJson<Record<string, unknown>>(join(this.stateDir, 'runtime-preferences.json'), 'runtime-preferences.json') ?? {};
    const next = { ...current, ...patch };
    await atomicJson(join(this.stateDir, 'runtime-preferences.json'), next);
    if (typeof patch.autoRemotePricingSync === 'boolean') {
      this.usageManager.setAutoRemotePricingSync(patch.autoRemotePricingSync === true);
      await atomicJson(join(this.stateDir, 'pricing-preferences.json'), { enabled: patch.autoRemotePricingSync === true });
    }
    if (Backend.RUNTIME_PREF_KEYS.some(key => key in patch)) this.onRuntimePreferencesChanged?.();
    return this.config();
  }

  /**
   * 智能切换推荐:复用核心层 selectBestAccount 优先级/轮询算法,
   * 结合当前活动账号的实时配额(与 account_list 相同的融合语义)。
   */
  async autoSwitchRecommend() {
    const live = await this.probeLiveCached().catch(() => null);
    const listRes = await this.accountsManager.listAccounts({ liveEmailHint: live?.email ?? null }).catch(() => null);
    const detectedEmail = live?.email ?? await this.accountsManager.detectCurrentAntigravityEmail({ liveEmailHint: null }).catch(() => null) ?? null;
    const currentSummary = detectedEmail ? listRes?.accounts.find(a => a.email.toLowerCase() === detectedEmail.toLowerCase()) : null;
    const currentSaved = currentSummary ? await this.accountsManager.getAccount(currentSummary.id).catch(() => null) : null;
    const mergedQuota = currentSaved
      ? mergeLiveQuotaWithSaved(currentSaved.quota, live?.email?.toLowerCase() === currentSaved.email.toLowerCase() ? live.quota : null)
      : null;
    const result = await this.accountsManager.selectBestAccount(undefined, {
      currentId: currentSaved?.id ?? listRes?.active_account?.id,
      currentEmail: detectedEmail ?? currentSaved?.email,
      currentQuota: mergedQuota ?? undefined,
    });
    const cfg = await this.accountsManager.getAutoSwitchConfig().catch(() => null);
    const best = result.bestCandidate;
    return {
      enabled: cfg?.enabled ?? false,
      shouldSwitch: result.shouldSwitch,
      reason: result.reason,
      currentEmail: result.currentAccount?.email ?? detectedEmail ?? '',
      currentRemaining: result.currentAccount ? this.accountsManager.getAccountRemaining(result.currentAccount, cfg?.monitored_model ?? 'all') : null,
      bestCandidate: best ? {
        id: best.id,
        email: best.email,
        name: best.name ?? null,
        remaining: this.accountsManager.getAccountRemaining(best, cfg?.monitored_model ?? 'all'),
      } : null,
    };
  }

  /**
   * AntigravityBox 扩展 — 把所有已保存账号的当前配额余量落入本地历史(JSONL),
   * 供总览页 24h/7d 曲线使用。每次配额刷新后与启动时各记一次。
   */
  async recordQuotaSnapshot(): Promise<{ ok: boolean; accounts: number }> {
    const index = await this.accountsManager.loadIndex().catch(() => null);
    if (!index?.accounts?.length) return { ok: false, accounts: 0 };
    const accounts = await Promise.all(index.accounts.map(async (summary) => {
      const saved = await this.accountsManager.getAccount(summary.id).catch(() => null);
      if (!saved) return null;
      const overview = this.accountsManager.getAccountQuotaOverview(saved);
      return {
        id: saved.id,
        email: saved.email,
        fiveHour: overview.fiveHourRemaining,
        weekly: overview.weeklyRemaining,
      };
    }));
    const valid = accounts.filter((a): a is NonNullable<typeof a> => a !== null);
    const result = await appendQuotaSnapshot(this.stateDir, valid);
    return { ok: result.ok, accounts: valid.length };
  }

  /** AntigravityBox 扩展 — 读取配额历史(hours: 24 或 168)。 */
  async quotaHistory(hours: number) {
    return readQuotaHistory(this.stateDir, hours);
  }

  /** AntigravityBox 扩展 — 会话库概览(只读;文件清单 + 账本聚合统计)。 */
  async conversationOverview() {
    const { conversations } = await this.usageManager.conversationOverview();
    return { conversations, geminiDir: this.geminiDir };
  }

  /** AntigravityBox 扩展 — 单会话库逐请求明细(指标脱敏)。 */
  async conversationEvents(file: string) {
    return this.usageManager.conversationEvents(file);
  }

  /** AntigravityBox 扩展 — 个人词典层读写(DictionaryStore 的 fs.watch 会在写入后自动重载)。 */
  async personalDictionary() {
    const userDir = join(this.stateDir, 'dictionary');
    const entries = await readPersonalDictionary(userDir).catch((error: unknown) => {
      throw new Error(`个人词典读取失败:${error instanceof Error ? error.message : String(error)}`);
    });
    return { entries, path: personalDictionaryPath(userDir), count: Object.keys(entries).length };
  }

  async savePersonalDictionary(entries: Record<string, string>) {
    const userDir = join(this.stateDir, 'dictionary');
    return writePersonalDictionary(userDir, entries);
  }

  async maintenanceScan(options?: { retentionDays?: number }) {
    const scan = await this.maintenance.scan(options);
    return scan;
  }

  /** 两段式清理:token 来自 120 秒内的 scan;Antigravity 未退出时核心层会安全拒绝。 */
  async maintenanceClear(token: unknown, selectedNames?: unknown) {
    return await this.maintenance.clear(token, selectedNames, { keepLocalSnapshots: 1 });
  }

  /** 按快照原样恢复清理过的缓存(Antigravity 未退出时核心层会安全拒绝)。 */
  async maintenanceRestore(snapshotId: unknown) {
    return await this.maintenance.restore(snapshotId);
  }

  async dashboardSummary() {
    const errors: Record<string, string> = {};
    let accounts: unknown = null;
    let usage: unknown = null;
    try {
      const aggregate = await this.buildDashboardAggregate();
      accounts = aggregate.accounts;
      usage = aggregate.usage;
      if (aggregate.accountsError) errors.accounts = sanitizeErrorMessage(aggregate.accountsError);
      if (aggregate.usageError) errors.usage = sanitizeErrorMessage(aggregate.usageError);
    } catch (error) {
      errors.dashboard = sanitizeErrorMessage(error);
    }
    return {
      accounts,
      usage,
      accountsError: errors.accounts ?? null,
      usageError: errors.usage ?? null,
      generatedAt: new Date().toISOString(),
    };
  }

  private async buildDashboardAggregate() {
    const livePromise = this.probeLiveCached().catch(() => null);
    let accounts: unknown = null, accountsError: unknown = null;
    let usage: unknown = null, usageError: unknown = null;
    try {
      const listRes = await this.accountsManager.listAccounts({ liveEmailHint: (await livePromise)?.email ?? null });
      const live = await livePromise;
      const detectedEmail = live?.email ?? await this.accountsManager.detectCurrentAntigravityEmail({ liveEmailHint: null }).catch(() => null);
      const active = detectedEmail
        ? listRes.accounts.find(a => a.email.toLowerCase() === detectedEmail.toLowerCase())
        : listRes.active_account;
      const activeSaved = active ? await this.accountsManager.getAccount(active.id).catch(() => null) : null;
      const liveQuotaForMatched = activeSaved && active && live?.email?.toLowerCase() === active.email?.toLowerCase() ? live.quota : null;
      const acc = activeSaved ? { ...activeSaved, quota: mergeLiveQuotaWithSaved(activeSaved.quota, liveQuotaForMatched) } : (activeSaved ?? (live?.quota ? { id: 'live', email: live.email, quota: live.quota } : null));
      const overview = acc ? projectAccountForIpcNormalized(acc as Account, this.accountsManager, {
        includeOverviewFields: true,
        formatResetTime,
        revisionWithReadiness: true,
      }) : null;
      accounts = { active: overview, count: listRes.accounts.length };
    } catch (error) { accountsError = error; }
    try {
      await this.syncAccountContextToUsage();
      usage = projectAccountUsage(await this.usageManager.getUsageSummary());
    } catch (error) { usageError = error; }
    return { accounts, usage, accountsError, usageError };
  }
}

/** Project a TokenUsageSummary into the UI-facing shape (semantics from ipc-projections). */
function projectAccountUsage(usage: Awaited<ReturnType<UsageStatsManager['getUsageSummary']>>) {
  const period = (p: 'today' | 'last_7_days' | 'last_30_days' | 'all_time') => {
    const data = usage[p] ?? usage.all_time;
    const cacheDenom = data.totals.input_tokens + data.totals.cached_tokens + (data.totals.cache_write_tokens ?? 0);
    const cacheHitRate = cacheDenom > 0 ? Math.round((data.totals.cached_tokens / cacheDenom) * 1000) / 10 : 0;
    return {
      totals: data.totals,
      byModel: data.by_model,
      estimatedUsd: data.estimated_usd,
      cacheSavingsUsd: data.cache_savings_usd ?? 0,
      requestCount: data.totals.request_count,
      cacheHitRate,
      dailyTrends: p === 'today' || p === 'last_7_days' || p === 'last_30_days' ? (usage.daily_trends ?? []).slice(-(p === 'today' ? 1 : p === 'last_7_days' ? 7 : 30)) : usage.daily_trends ?? [],
      todayHourly: usage.today_hourly ?? [],
    };
  };
  return {
    today: period('today'),
    '7d': period('last_7_days'),
    '30d': period('last_30_days'),
    all: period('all_time'),
    availability: usage.availability,
    lastScannedAt: usage.last_attempt_at ?? usage.generated_at,
    databasesScanned: usage.databases_scanned,
    databasesDiscovered: usage.databases_discovered,
    hasError: usage.has_error === true,
    snapshotId: usage.snapshot_id,
  };
}
