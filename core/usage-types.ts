// Ported from Enzoo404/gravitybox (MIT License) v1.1.2 — https://github.com/Enzoo404/gravitybox
// Windows adaptation: AntigravityBox project.
import type { ApiPricing } from './pricing.js';
import { stripModelProviderPrefix } from './model-identity.js';
import { getEffectiveModelAliasKeys, getEffectiveModelPriceAlias } from './model-catalog.js';
import type { LedgerEvent } from './usage-ledger.js';
import { USAGE_PROJECTION_VERSION } from './protobuf-projection.js';
import { bt } from './i18n.js';

export interface TokenUsageTotals {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
}

export interface ModelTokenUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
  estimated_usd: number;
  /** 缓存节省估算:命中缓存按未命中全价计费所省下的等效美元 */
  cache_savings_usd?: number;
  priced?: boolean;
  partiallyPriced?: boolean;
  unpriced_tokens?: number;
  pricingKey?: string; pricingStatus?: string; pricingProvenance?: ApiPricing["provenance"] | null;
}

export interface DailyTokenUsage {
  date: string; // YYYY-MM-DD
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
}

export interface HourlyTokenUsage {
  hour: string; // YYYY-MM-DD HH:00
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
}

export interface TokenUsagePeriod {
  totals: TokenUsageTotals;
  estimated_usd: number;
  cache_savings_usd?: number;
  by_model: ModelTokenUsage[];
  priced_models?: number;
  unpriced_models?: number;
}

export interface TokenUsageSummary {
  today: TokenUsagePeriod;
  last_7_days: TokenUsagePeriod;
  last_30_days: TokenUsagePeriod;
  all_time: TokenUsagePeriod;
  daily_trends: DailyTokenUsage[];
  today_hourly: HourlyTokenUsage[];
  databases_scanned: number;
  databases_discovered?: number;
  scan_scope_description?: string;
  generations_scanned: number;
  skipped_large_records: number;
  generated_at: number;
  priced_models?: number;
  unpriced_models?: number;
  failed_databases_count?: number;
  has_error?: boolean;
  hasError?: boolean;
  availability?: 'complete' | 'partial' | 'cached' | 'unavailable';
  unknown_time_records?: number;
  unknown_time_tokens?: number;
  database_diagnostics?: { id: string; state: string; category: string; lastSuccessAt?: number }[];
  snapshot_id?: string;
  last_attempt_at?: number;
  pricing_warnings?: string[];
  pricing_warning_codes?: string[];
  unattributed_requests?: number;
  unattributed_tokens?: number;
  ledger_review_records?: number;
  historical_amount_receipts?: { unmatchedCount: number; unmatchedUsd: number };
  available_accounts?: AvailableAccountUsageOption[];
  selected_account_id?: string;
}

export interface AvailableAccountUsageOption {
  id: string; // 'all' | accountId | email
  label: string; // '全部账号' | 'account-one@example.invalid' | 'account-two@example.invalid'
  email?: string;
  name?: string | null;
  type?: 'all' | 'account';
  total_tokens?: number;
  request_count?: number;
}

export interface GenerationEvent {
  event_key?: string;
  source_id?: string;
  source_observed_at?: number;
  generation_index?: number;
  legacy_event_key?: string;
  account_confidence?: 'observed' | 'unknown' | 'legacy';
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  timestamp_seconds: number;
  account_id?: string;
  account_email?: string;
  account_type?: 'consumer' | 'enterprise_vertex' | 'unknown';
  project_id?: string;
}

/**
 * 基于 Antigravity 数据库 (gen_metadata) 提取真实 Response model 名称（如 "gemini-3.8-flash-n", "gemini-3.8-flash-exp-a"），不包含推理程度 high/medium/low。
 * 针对 Vertex AI / GCP 路径前缀（如 publishers/google/models/gemini-4-carbon）自动解耦并清洗为规范模型名称。
 * 同时对 Orchestrator 双阶段模式（Plan Mode: Argon / Carbon；Execution Mode: gemini-flash-worker-agy / 1669）执行方案 B 归一化合并。
 */
export const CANONICAL_UNKNOWN_MODEL = '未知模型';

export function isUnknownModelName(name: string | null | undefined): boolean {
  const clean = typeof name === 'string' ? name.trim() : '';
  return clean === CANONICAL_UNKNOWN_MODEL || clean.toLowerCase() === 'unknown model';
}

const ORCHESTRATOR_THINKING_SUFFIX_RE = /-(?:extra-high|extra-low|xhigh|high|medium|low|thinking)$/i;

/**
 * 动态识别尚未入库的新代号 Orchestrator（如 gemini-pro-orchestrator-<codename> 或 Orchestrator (<Codename>)），
 * 仅合并模型身份，绝不自行伪造定价。
 */
export function resolveDynamicOrchestratorModel(
  strippedId: string,
  cleanLabel: string,
  siblingModelIds?: Iterable<string>
): string | null {
  const idText = String(strippedId ?? '').trim();
  const labelText = String(cleanLabel ?? '').trim();
  const idCodename = idText.match(/^gemini-pro-orchestrator-(?!g1(?:-|$)|default$|pro$)([a-z][a-z0-9]*)$/i)?.[1];
  const labelCodename =
    idText.match(/^Orchestrator\s*\(\s*([a-z][a-z0-9]*)\s*\)$/i)?.[1] ??
    labelText.match(/^Orchestrator\s*\(\s*([a-z][a-z0-9]*)\s*\)$/i)?.[1];
  const rawCodename = idCodename ?? labelCodename;
  if (!rawCodename) return null;
  const codename = rawCodename.toLowerCase();
  if (codename === 'pro' || codename === 'flash' || codename === 'default' || codename === 'unknown' || codename === 'g1') {
    return null;
  }
  const cap = codename.charAt(0).toUpperCase() + codename.slice(1);
  const explicitAlias =
    getEffectiveModelPriceAlias(`gemini-pro-orchestrator-${codename}`) ??
    getEffectiveModelPriceAlias(`Orchestrator (${cap})`) ??
    getEffectiveModelPriceAlias(`orchestrator (${codename})`);
  if (explicitAlias) return explicitAlias;

  const versionedRe = new RegExp(`^gemini-(\\d+(?:\\.\\d+)?)-${codename}$`, 'i');
  if (siblingModelIds) {
    for (const raw of siblingModelIds) {
      const cleaned = stripModelProviderPrefix(String(raw ?? ''))
        .trim()
        .replace(/(?:^|[-_])disabled$/i, '')
        .replace(ORCHESTRATOR_THINKING_SUFFIX_RE, '');
      const m = cleaned.match(versionedRe);
      if (m) return `gemini-${m[1]}-${codename}`;
    }
  }
  for (const known of getEffectiveModelAliasKeys()) {
    const m = known.match(versionedRe);
    if (m) return `gemini-${m[1]}-${codename}`;
  }
  return `gemini-4-${codename}`;
}

export function resolveDatabaseModelFullName(
  modelId: string | null | undefined,
  label: string | null | undefined,
  modelEnum?: number | null,
  options?: { canonicalUnknown?: boolean; siblingModelIds?: Iterable<string> }
): string {
  const rawId = typeof modelId === 'string' ? modelId.trim() : '';
  const cleanId = isUnknownModelName(rawId) ? '' : rawId;
  const strippedId = cleanId ? (stripModelProviderPrefix(cleanId) || cleanId) : '';
  const rawLabel = typeof label === 'string' ? label.trim() : '';
  const cleanLabel = isUnknownModelName(rawLabel) ? '' : rawLabel;

  // Antigravity Orchestrator 双阶段模型归一化：
  // 1. 规划阶段 (Plan Mode)：旧版 response_model 恒为 "gemini-pro-orchestrator-g1-pro"，需结合 label / model_enum 区分 Carbon / Hydrogen / Argon；
  // 2. 其他已知历史 ID 与远端热更新别名优先走 getEffectiveModelPriceAlias，未知新变体原样保留以便归入未计价统计（禁止前缀猜名伪造费用）。
  const isLegacyAmbiguousOrchestratorId =
    /^gemini-pro-orchestrator(?:-g1-pro)?$/i.test(strippedId) ||
    /^MODEL_PLACEHOLDER_M66[78]$/i.test(strippedId) ||
    /^Orchestrator\s*\(\s*(?:Carbon|Hydrogen|Argon)\s*\)$/i.test(strippedId);

  if (!strippedId || isLegacyAmbiguousOrchestratorId) {
    if (/\bcarbon\b/i.test(cleanLabel) || /\bcarbon\b/i.test(strippedId) || modelEnum === 1667 || /M667$/i.test(strippedId)) {
      return getEffectiveModelPriceAlias('MODEL_PLACEHOLDER_M667') ?? 'gemini-4-carbon';
    }
    if (/\bhydrogen\b/i.test(cleanLabel) || /\bhydrogen\b/i.test(strippedId)) {
      return getEffectiveModelPriceAlias(cleanLabel) ?? 'gemini-4-hydrogen';
    }
    if (/\bargon\b/i.test(cleanLabel) || /\bargon\b/i.test(strippedId) || modelEnum === 1668 || /M668$/i.test(strippedId)) {
      return getEffectiveModelPriceAlias('MODEL_PLACEHOLDER_M668') ?? 'gemini-4-argon';
    }
    if (cleanLabel) {
      const labelAlias = getEffectiveModelPriceAlias(cleanLabel);
      if (labelAlias) return labelAlias;
    }
    const dynamicOrchestrator = resolveDynamicOrchestratorModel(strippedId, cleanLabel, options?.siblingModelIds);
    if (dynamicOrchestrator) return dynamicOrchestrator;
  }

  if (
    /^gemini-flash-worker(?:-agy)?$/i.test(strippedId) ||
    /^MODEL_PLACEHOLDER_M669$/i.test(strippedId) ||
    modelEnum === 1669 ||
    (!strippedId && /^Gemini\s+Flash$/i.test(cleanLabel))
  ) {
    if (/\bhydrogen\b/i.test(cleanLabel) || /\bhydrogen\b/i.test(strippedId)) {
      return 'gemini-4-hydrogen';
    }
    const workerAlias = strippedId
      ? (getEffectiveModelPriceAlias(strippedId) ?? getEffectiveModelPriceAlias(cleanId))
      : undefined;
    return workerAlias ?? getEffectiveModelPriceAlias('MODEL_PLACEHOLDER_M669') ?? 'gemini-3.8-flash';
  }

  const normalizeDisplayLabel = (lbl: string): string =>
    lbl
      .replace(/\s*[（(]\s*(?:extra[\s-]*high|extra[\s-]*low|xhigh|high|medium|low|thinking|max)\s*[）)]\s*$/i, '')
      .replace(/\s+(?:extra[\s-]*high|extra[\s-]*low|xhigh|high|medium|low|thinking|max)\s*$/i, '')
      .trim() || lbl;

  if (cleanId) {
    const dynamicIdAlias = getEffectiveModelPriceAlias(strippedId) ?? getEffectiveModelPriceAlias(cleanId);
    if (dynamicIdAlias) return dynamicIdAlias;
    if (/^(?:gemini-pro-orchestrator|gemini-pro-orchestrator-g1-pro|gemini-pro-orchestrator-argon)$/i.test(strippedId)) {
      return 'gemini-4-argon';
    }
    const dynamicOrchestrator = resolveDynamicOrchestratorModel(strippedId, cleanLabel, options?.siblingModelIds);
    if (dynamicOrchestrator) return dynamicOrchestrator;
    if (/^MODEL_PLACEHOLDER_M\d+$/i.test(strippedId) && cleanLabel) {
      const normalizedLabel = normalizeDisplayLabel(cleanLabel);
      return getEffectiveModelPriceAlias(normalizedLabel) ?? normalizedLabel;
    }
    if (strippedId) return strippedId;
    return cleanId;
  }
  if (cleanLabel) {
    const normalizedLabel = normalizeDisplayLabel(cleanLabel);
    return getEffectiveModelPriceAlias(normalizedLabel) ?? normalizedLabel;
  }
  return options?.canonicalUnknown ? CANONICAL_UNKNOWN_MODEL : bt('usage.unknown_model');
}

export interface FileCacheEntry {
  mtimeMs: number;
  size: number;
  walMtimeMs: number;
  walSize: number;
  events: GenerationEvent[];
  generationsScanned: number;
  skippedLargeRecords: number;
  projectionVersion?: number;
  hasError?: boolean;
  error?: string;
  lastSuccessAt?: number;
}

export function isFileCacheEntryReusable(
  entry: Pick<FileCacheEntry, 'hasError' | 'skippedLargeRecords' | 'size' | 'projectionVersion'> | undefined | null
): boolean {
  if (!entry || entry.hasError) return false;
  if (entry.projectionVersion !== USAGE_PROJECTION_VERSION) {
    if (entry.projectionVersion !== undefined) return false;
    if ((entry.skippedLargeRecords ?? 0) > 0) return false;
    if (entry.size > 16 * 1024 * 1024) return false;
  }
  return true;
}

export function ledgerEventsEqual(a: LedgerEvent, b: LedgerEvent): boolean {
  for (const key of Object.keys(a) as (keyof LedgerEvent)[]) {
    if (a[key] !== b[key]) return false;
  }
  for (const key of Object.keys(b) as (keyof LedgerEvent)[]) {
    if (!(key in a) && b[key] !== undefined) return false;
  }
  return true;
}
