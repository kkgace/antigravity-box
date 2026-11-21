// Ported from Enzoo404/gravitybox (MIT License) v1.1.2 — https://github.com/Enzoo404/gravitybox
// Windows adaptation: AntigravityBox project.
import { computeAccountRevision, type AccountsManager, type Account, type AccountSummary, type QuotaOverview, projectAccountForIpc } from './accounts.js';
import type { ModelTokenUsage, TokenUsagePeriod, TokenUsageSummary } from './usage.js';
import { localizePricingProvenance } from './pricing.js';
import { bt } from './i18n.js';

/** 套餐枚举统一收口；空值/未知值一律回落到“待确认”，空串不得穿透 IPC。 */
export function normalizeSubscriptionTier(value: unknown): string {
  const pending = bt('quota.tier.pending');
  if (typeof value !== 'string') return pending;
  const raw = value.trim();
  if (!raw) return pending;
  const upper = raw.toUpperCase();
  if (upper === 'FREE') return 'FREE';
  if (upper === 'PRO') return 'PRO';
  if (upper === 'ULTRA') return 'ULTRA';
  if (upper === 'ENTERPRISE') return 'ENTERPRISE';
  if (upper === 'TEAM' || upper === 'TEAMS' || upper === 'BUSINESS' || upper === 'WORKSPACE') return 'TEAM';
  if (upper === 'PLUS') return 'PLUS';
  if (/\bULTRA\b/i.test(raw)) return 'ULTRA';
  if (/\bENTERPRISE\b/i.test(raw)) return 'ENTERPRISE';
  if (/\b(?:TEAM|TEAMS|BUSINESS|WORKSPACE)\b/i.test(raw)) return 'TEAM';
  if (/\bPLUS\b/i.test(raw)) return 'PLUS';
  if (/\bPRO\b/i.test(raw) || /\bAI\s+PREMIUM\b/i.test(raw)) return 'PRO';
  if (/\b(?:FREE|STARTER|TRIAL)\b/i.test(raw)) return 'FREE';
  return pending;
}

/** Single contract for dashboard, account cards, menu and refresh replies. No credentials. */
export function projectQuotaContract(overview: {
  familyWindows?: unknown;
  familyModelQuota?: unknown;
  argonStatus?: unknown;
  carbonStatus?: unknown;
  standaloneModels?: unknown[];
  projectedQuotaGroups?: unknown[];
  quotaGroups?: unknown[];
  refreshState?: unknown;
  quotaWarnings?: unknown;
  quotaWarningCodes?: unknown;
}): Record<string, unknown> {
  const projectedGroups = Array.isArray(overview.projectedQuotaGroups)
    ? overview.projectedQuotaGroups
    : (Array.isArray(overview.quotaGroups)
      && overview.quotaGroups.every(item => item && typeof item === 'object' && Array.isArray((item as { windows?: unknown }).windows)))
      ? overview.quotaGroups
      : [];
  return {
    familyWindows: overview.familyWindows,
    familyModelQuota: overview.familyModelQuota,
    argonStatus: overview.argonStatus,
    carbonStatus: overview.carbonStatus ?? null,
    standaloneModels: overview.standaloneModels ?? [],
    quotaGroups: projectedGroups,
    refreshState: overview.refreshState,
    quotaWarnings: overview.quotaWarnings,
    quotaWarningCodes: overview.quotaWarningCodes,
  };
}

export interface ProjectAccountIpcOptions {
  overview?: QuotaOverview;
  nowMs?: number;
  includeOverviewFields?: boolean;
  formatResetTime?: (resetTime: number | null | undefined) => string;
  revisionWithReadiness?: boolean;
}

export function projectAccountForIpcNormalized(
  account: Parameters<typeof projectAccountForIpc>[0],
  accountsManager: Pick<AccountsManager, 'getAccountQuotaOverview'>,
  options?: ProjectAccountIpcOptions,
): Record<string, unknown> | null {
  if (!account) return null;
  const projected = projectAccountForIpc(account) as Record<string, unknown> | null;
  if (!projected) return projected;
  const overview = options?.overview ?? accountsManager.getAccountQuotaOverview(
    account,
    options?.nowMs !== undefined ? { nowMs: options.nowMs } : undefined,
  );
  const normalizedTier = normalizeSubscriptionTier(
    options?.includeOverviewFields ? overview.subscriptionTier : projected.subscription_tier,
  );
  const contract = projectQuotaContract(overview);
  const normalized: Record<string, unknown> = {
    ...projected,
    subscription_tier: normalizedTier,
    ...contract,
  };
  if (options?.revisionWithReadiness) {
    const revBase = computeAccountRevision(account as Account | AccountSummary);
    const readinessState = (projected.credentialReadiness as { state?: string } | undefined)?.state ?? 'ready';
    normalized.revision = `${revBase}:${readinessState}`;
  }
  if (projected.quota && typeof projected.quota === 'object') {
    const quotaObj = projected.quota as Record<string, unknown>;
    normalized.quota = {
      ...quotaObj,
      subscription_tier: normalizeSubscriptionTier(quotaObj.subscription_tier ?? normalizedTier),
      ...contract,
    };
  }
  if (options?.includeOverviewFields) {
    const lastUp = Number(projected.quota_last_updated ?? (projected.quota as { last_updated?: unknown } | null)?.last_updated ?? 0);
    const resetTimeStr = options.formatResetTime
      ? options.formatResetTime(overview.resetTime)
      : (overview.resetTime !== null && overview.resetTime !== undefined ? String(overview.resetTime) : '');
    Object.assign(normalized, {
      quota_last_updated: lastUp,
      quotaLastUpdated: lastUp,
      fiveHourRemaining: overview.fiveHourRemaining,
      weeklyRemaining: overview.weeklyRemaining,
      geminiFiveHourRemaining: overview.geminiFiveHourRemaining,
      geminiWeeklyRemaining: overview.geminiWeeklyRemaining,
      geminiFiveHourResetCountdown: overview.geminiFiveHourResetCountdown ?? '',
      geminiWeeklyResetCountdown: overview.geminiWeeklyResetCountdown ?? '',
      geminiResetCountdown: overview.geminiResetCountdown,
      claudeFiveHourRemaining: overview.claudeFiveHourRemaining,
      claudeWeeklyRemaining: overview.claudeWeeklyRemaining,
      claudeFiveHourResetCountdown: overview.claudeFiveHourResetCountdown ?? '',
      claudeWeeklyResetCountdown: overview.claudeWeeklyResetCountdown ?? '',
      claudeResetCountdown: overview.claudeResetCountdown,
      argonWeeklyRemaining: overview.argonWeeklyRemaining,
      argonWeeklyResetCountdown: overview.argonWeeklyResetCountdown ?? '',
      argonResetCountdown: overview.argonResetCountdown,
      carbonWeeklyRemaining: overview.carbonWeeklyRemaining,
      carbonWeeklyResetCountdown: overview.carbonWeeklyResetCountdown ?? '',
      carbonResetCountdown: overview.carbonResetCountdown,
      staleGroups: overview.staleGroups,
      stale_groups: overview.staleGroups,
      resetTime: resetTimeStr,
      resetCountdown: overview.resetCountdown,
      models: overview.models,
    });
    const baseQuota = (normalized.quota && typeof normalized.quota === 'object')
      ? (normalized.quota as Record<string, unknown>)
      : {};
    normalized.quota = {
      ...baseQuota,
      five_hour_remaining: overview.fiveHourRemaining,
      weekly_remaining: overview.weeklyRemaining,
      subscription_tier: normalizedTier,
      reset_time: overview.resetTime ?? null,
      reset_countdown: overview.resetCountdown,
      quota_groups: overview.quotaGroups,
      stale_groups: overview.staleGroups,
      models: overview.models,
      ...contract,
    };
  }
  return normalized;
}

function projectSingleUsagePeriod(usage: TokenUsageSummary, periodInput: unknown) {
  const periodKey: 'today' | 'last_7_days' | 'last_30_days' | 'all_time' =
    periodInput === 'today' ? 'today' : periodInput === '7d' ? 'last_7_days' : periodInput === '30d' ? 'last_30_days' : 'all_time';
  const p: TokenUsagePeriod = usage[periodKey] ?? usage.all_time;
  const byModel = p.by_model.map((m: ModelTokenUsage) => ({
    model: m.model,
    promptTokens: m.input_tokens,
    candidatesTokens: m.output_tokens,
    cachedTokens: m.cached_tokens,
    cacheWriteTokens: m.cache_write_tokens ?? 0,
    totalTokens: m.total_tokens,
    requestCount: m.request_count,
    estimatedUsd: m.estimated_usd,
    priced: m.priced === true,
    partiallyPriced: m.partiallyPriced === true,
    unpricedTokens: m.unpriced_tokens ?? 0,
    pricingKey: m.pricingKey,
    pricingStatus: m.pricingStatus,
    pricingProvenance: localizePricingProvenance(m.pricingProvenance) ?? null,
    input_tokens: m.input_tokens,
    output_tokens: m.output_tokens,
    cached_tokens: m.cached_tokens,
    cache_write_tokens: m.cache_write_tokens ?? 0,
    total_tokens: m.total_tokens,
    request_count: m.request_count,
    estimated_usd: m.estimated_usd,
  }));
  const cacheDenom = p.totals.input_tokens + p.totals.cached_tokens + (p.totals.cache_write_tokens ?? 0);
  const cacheHitRate = cacheDenom > 0 ? Math.round((p.totals.cached_tokens / cacheDenom) * 1000) / 10 : 0;
  const lastScannedAt = (usage.availability === 'cached'
    ? usage.generated_at
    : (usage.last_attempt_at ?? usage.generated_at)) ?? 0;
  const periodSummary = {
    ...usage,
    totalTokens: p.totals.total_tokens,
    promptTokens: p.totals.input_tokens,
    candidatesTokens: p.totals.output_tokens,
    cachedTokens: p.totals.cached_tokens,
    cacheWriteTokens: p.totals.cache_write_tokens ?? 0,
    requestCount: p.totals.request_count,
    estimatedUsd: p.estimated_usd,
    cacheHitRate,
    total_tokens: p.totals.total_tokens,
    input_tokens: p.totals.input_tokens,
    output_tokens: p.totals.output_tokens,
    cached_tokens: p.totals.cached_tokens,
    cache_write_tokens: p.totals.cache_write_tokens ?? 0,
    request_count: p.totals.request_count,
    estimated_usd: p.estimated_usd,
    databasesScanned: usage.databases_scanned,
    databasesDiscovered: usage.databases_discovered,
    scanScopeDescription: usage.scan_scope_description,
    pricedModels: p.priced_models ?? usage.priced_models ?? 0,
    unpricedModels: p.unpriced_models ?? usage.unpriced_models ?? 0,
    failedDatabasesCount: usage.failed_databases_count ?? 0,
    skippedLargeRecords: usage.skipped_large_records ?? 0,
    lastScannedAt,
    hasError: usage.has_error === true,
    availability: usage.availability ?? 'complete',
    unknownTimeRecords: usage.unknown_time_records ?? 0,
    unknownTimeTokens: usage.unknown_time_tokens ?? 0,
    databaseDiagnostics: usage.database_diagnostics ?? [],
    selectedAccountId: usage.selected_account_id ?? 'all',
    selected_account_id: usage.selected_account_id ?? 'all',
    availableAccounts: usage.available_accounts ?? [],
    available_accounts: usage.available_accounts ?? [],
  };
  const { today: _t, last_7_days: _w, last_30_days: _m, all_time: _a, daily_trends, today_hourly, ...selectedSummary } = periodSummary;
  const safeDailyTrends = Array.isArray(daily_trends) ? daily_trends : [];
  const safeTodayHourly = Array.isArray(today_hourly) ? today_hourly : [];
  const days = periodInput === 'today' ? 1 : periodInput === '7d' ? 7 : periodInput === '30d' ? 30 : null;
  const selectedTrends = days ? safeDailyTrends.slice(-days) : safeDailyTrends;
  return {
    ok: true,
    period: typeof periodInput === 'string' ? periodInput : 'all',
    snapshotId: usage.snapshot_id,
    selectedAccountId: usage.selected_account_id ?? 'all',
    availableAccounts: usage.available_accounts ?? [],
    summary: selectedSummary,
    byModel,
    models: byModel,
    dailyTrends: selectedTrends,
    todayHourly: periodInput === 'today' ? safeTodayHourly : [],
  };
}

export function projectAllUsagePeriodSummaries(usage: TokenUsageSummary) {
  return {
    today: projectSingleUsagePeriod(usage, 'today'),
    '7d': projectSingleUsagePeriod(usage, '7d'),
    '30d': projectSingleUsagePeriod(usage, '30d'),
    all: projectSingleUsagePeriod(usage, 'all'),
  };
}

export function projectUsagePeriodSummary(usage: TokenUsageSummary, periodInput: unknown, options?: { includeAllPeriods?: boolean }) {
  const projected = projectSingleUsagePeriod(usage, periodInput);
  if (options?.includeAllPeriods) {
    return {
      ...projected,
      periods: projectAllUsagePeriodSummaries(usage),
    };
  }
  return projected;
}
