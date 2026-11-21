// Ported from Enzoo404/gravitybox (MIT License) v1.1.2 — https://github.com/Enzoo404/gravitybox
// Windows adaptation: AntigravityBox project.
import { readFile } from 'node:fs/promises';
import { atomicJson, readOptionalJson } from './files.js';
import { APP_VERSION } from './version.js';
import {
  FEED_MODEL_KEYS,
  resetAndRegisterRemoteModelMetadata,
  sanitizeRemoteModelMetadata,
} from './model-catalog.js';
import {
  DEFAULT_API_PRICES,
  DEFAULT_PRICING_FEED_URLS,
  PRICING_METADATA,
  isInternalNonChatModelId,
  mergePricingEntries,
  resolvePricingFromTable,
  validateRawPrices,
  type ApiPricing,
  type ApiPricingEntry,
  type ApiPricingInterval,
} from './pricing.js';
import { bt } from './i18n.js';

export interface PricingSyncMutableState {
  lastRemoteSyncAt: number;
  lastSyncSuccess: boolean;
  lastCheckAt: number;
  lastCheckSuccess: boolean;
  nextAutoSyncAt: number;
  lastSyncError: string | null;
  lastSyncedSourceUrl: string;
  lastSyncedVersion: string;
}

export function compareDatedFeedVersion(left: string, right: string): number | null {
  const pattern = /^(\d{4}-\d{2}-\d{2})(?:[.-]r?(\d+))?$/i;
  const leftMatch = left.trim().match(pattern);
  const rightMatch = right.trim().match(pattern);
  if (!leftMatch || !rightMatch) return null;
  const dateDiff = leftMatch[1]!.localeCompare(rightMatch[1]!);
  if (dateDiff !== 0) return dateDiff;
  const leftRev = leftMatch[2] ? Number.parseInt(leftMatch[2], 10) : 0;
  const rightRev = rightMatch[2] ? Number.parseInt(rightMatch[2], 10) : 0;
  return leftRev - rightRev;
}

export async function loadRawPricingTable(
  remotePricingCachePath: string,
  pricingCachePath: string
): Promise<{ merged: Record<string, ApiPricingEntry>; warnings: string[]; publicKeys: Set<string> }> {
  const warnings: string[] = [];
  const merged: Record<string, ApiPricingEntry> = Object.assign(Object.create(null), DEFAULT_API_PRICES);
  const publicKeys = new Set<string>(FEED_MODEL_KEYS);

  // 1. 尝试合并本地远程缓存（禁止早于内置目录日期的旧远端缓存降级覆盖较新的官方目录）
  resetAndRegisterRemoteModelMetadata({});
  try {
    const rawRemote = await readFile(remotePricingCachePath, 'utf8');
    const parsedRemote = JSON.parse(rawRemote);
    const remotePrices = parsedRemote && typeof parsedRemote === 'object' && parsedRemote.prices ? parsedRemote.prices : parsedRemote;
    const remoteVer = typeof parsedRemote?.feedVersion === 'string' ? parsedRemote.feedVersion.trim() : '';
    const cmpToBuiltin = compareDatedFeedVersion(remoteVer, PRICING_METADATA.version);
    const isOlderDatedFeed = cmpToBuiltin !== null && cmpToBuiltin < 0;
    resetAndRegisterRemoteModelMetadata(parsedRemote, { onlyNewEntries: isOlderDatedFeed });
    if (remotePrices && typeof remotePrices === 'object' && !Array.isArray(remotePrices)) {
      const filteredRemote = isOlderDatedFeed
        ? Object.fromEntries(Object.entries(remotePrices).filter(([k]) => !Object.hasOwn(merged, k)))
        : remotePrices;
      const remoteAccepted = new Set<string>();
      mergePricingEntries(merged, filteredRemote, bt('pricing.warn.remote_entry_prefix'), warnings, remoteAccepted);
      for (const k of remoteAccepted) {
        if (!isInternalNonChatModelId(k)) publicKeys.add(k);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(bt('pricing.warn.remote_cache_unreadable'));
    }
  }

  // 2. 尝试合并用户自定义价格缓存（最高优先级）
  try {
    const rawCustom = await readFile(pricingCachePath, 'utf8');
    const cached = JSON.parse(rawCustom);
    if (cached && typeof cached === 'object' && !Array.isArray(cached)) {
      const customAccepted = new Set<string>();
      mergePricingEntries(merged, cached, bt('pricing.warn.custom_entry_prefix'), warnings, customAccepted);
      for (const k of customAccepted) {
        if (!isInternalNonChatModelId(k)) publicKeys.add(k);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(bt('pricing.warn.custom_unreadable'));
    }
  }

  return { merged, warnings, publicKeys };
}

export function resolvePricingTableFromRaw(
  raw: Record<string, ApiPricingEntry>,
  timestampSeconds = Math.floor(Date.now() / 1000),
  allowedKeys?: Set<string>
): Record<string, ApiPricing> {
  const resolved: Record<string, ApiPricing> = Object.create(null);
  for (const key of Object.keys(raw)) {
    if (allowedKeys && !allowedKeys.has(key)) continue;
    const p = resolvePricingFromTable(raw, key, timestampSeconds);
    if (p) resolved[key] = p;
  }
  return resolved;
}

export async function loadPricingSyncState(
  remotePricingCachePath: string,
  pricingSyncStatePath: string,
  state: PricingSyncMutableState
): Promise<void> {
  if (!state.lastRemoteSyncAt) {
    const data = await readOptionalJson<{ syncedAt?: string; sourceUrl?: string; feedVersion?: string }>(
      remotePricingCachePath,
      'remote-pricing-cache.json'
    );
    if (data?.syncedAt) {
      state.lastRemoteSyncAt = Date.parse(data.syncedAt) || 0;
      state.lastSyncSuccess = true;
      state.lastSyncedSourceUrl = data.sourceUrl ?? '';
      state.lastSyncedVersion = data.feedVersion ?? '';
    }
  }
  const checkData = await readOptionalJson<{ lastCheckAt?: number; lastCheckSuccess?: boolean; lastSyncError?: string | null }>(
    pricingSyncStatePath,
    'pricing-sync-state.json'
  );
  if (checkData && typeof checkData === 'object') {
    if (typeof checkData.lastCheckAt === 'number' && Number.isFinite(checkData.lastCheckAt)) {
      state.lastCheckAt = checkData.lastCheckAt;
    }
    if (typeof checkData.lastCheckSuccess === 'boolean') {
      state.lastCheckSuccess = checkData.lastCheckSuccess;
    }
    if (typeof checkData.lastSyncError === 'string' || checkData.lastSyncError === null) {
      state.lastSyncError = checkData.lastSyncError;
    }
  }
  if (!state.nextAutoSyncAt) {
    const lastAttemptAt = Math.max(state.lastCheckAt, state.lastRemoteSyncAt);
    if (lastAttemptAt > 0) {
      const cooldown = state.lastCheckAt > state.lastRemoteSyncAt && !state.lastCheckSuccess ? 300_000 : 86_400_000;
      state.nextAutoSyncAt = lastAttemptAt + cooldown;
    }
  }
}

export function selectRemotePricingCandidateUrls(options: {
  feedUrl?: string;
  customRemoteUrlConfigured: boolean;
  remotePricingUrl: string;
  fallbackPricingUrls: string[];
}): string[] {
  const { feedUrl, customRemoteUrlConfigured, remotePricingUrl, fallbackPricingUrls } = options;
  if (feedUrl) return [feedUrl];
  if (customRemoteUrlConfigured && fallbackPricingUrls === DEFAULT_PRICING_FEED_URLS) return [remotePricingUrl];
  if (remotePricingUrl && !fallbackPricingUrls.includes(remotePricingUrl)) return [remotePricingUrl, ...fallbackPricingUrls];
  return fallbackPricingUrls;
}

const MAX_PRICING_FEED_BYTES = 2 * 1024 * 1024;
const MAX_PRICING_FEED_REDIRECTS = 3;

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

export function assertAllowedPricingFeedUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw new Error(bt('pricing.err.url_invalid'));
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error(bt('pricing.err.url_format_invalid'));
  }
  if (parsed.username || parsed.password) throw new Error(bt('pricing.err.url_credentials_forbidden'));
  if (parsed.protocol === 'https:') return parsed.href;
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) {
    return parsed.href;
  }
  throw new Error(bt('pricing.err.https_trusted_only'));
}

async function fetchBoundedPricingFeed(initialUrl: string, signal: AbortSignal): Promise<Uint8Array> {
  let currentUrl = assertAllowedPricingFeedUrl(initialUrl);
  const initialIsHttps = new URL(currentUrl).protocol === 'https:';
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_PRICING_FEED_REDIRECTS; hop += 1) {
    res = await fetch(currentUrl, {
      signal,
      redirect: 'manual',
      headers: { 'User-Agent': `GravityBox/${APP_VERSION}` },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers?.get?.('location');
      if (!loc) throw new Error(`HTTP ${res.status}`);
      const nextUrl = assertAllowedPricingFeedUrl(new URL(loc, currentUrl).href);
      const parsedNext = new URL(nextUrl);
      if (initialIsHttps && parsedNext.protocol !== 'https:') {
        throw new Error(bt('pricing.err.https_trusted_only'));
      }
      currentUrl = nextUrl;
      continue;
    }
    break;
  }
  if (!res) throw new Error(bt('pricing.err.url_invalid'));
  if (res.status >= 300 && res.status < 400) {
    throw new Error(bt('pricing.err.too_many_redirects'));
  }
  if (res.url) {
    const verifiedFinal = assertAllowedPricingFeedUrl(res.url);
    if (initialIsHttps && new URL(verifiedFinal).protocol !== 'https:') {
      throw new Error(bt('pricing.err.https_trusted_only'));
    }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentLen = Number(res.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLen) && contentLen > MAX_PRICING_FEED_BYTES) {
    throw new Error(bt('pricing.err.response_too_large'));
  }
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_PRICING_FEED_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(bt('pricing.err.response_too_large'));
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }
  const rawBuf = await res.arrayBuffer();
  if (rawBuf.byteLength > MAX_PRICING_FEED_BYTES) {
    throw new Error(bt('pricing.err.response_too_large'));
  }
  return new Uint8Array(rawBuf);
}

export async function executeRemotePricingSync(options: {
  candidateUrls: string[];
  remotePricingCachePath: string;
  pricingSyncStatePath: string;
  state: PricingSyncMutableState;
  now: number;
}): Promise<{ synced: boolean; error?: string; count?: number; sourceUrl?: string; version?: string }> {
  const { candidateUrls, remotePricingCachePath, pricingSyncStatePath, state, now } = options;
  let lastError: any = null;
  for (const targetUrl of candidateUrls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const rawBytes = await fetchBoundedPricingFeed(targetUrl, controller.signal);
      const data = JSON.parse(new TextDecoder('utf-8').decode(rawBytes));
      const prices = data && typeof data === 'object' && data.prices ? data.prices : data;
      const validated = validateRawPrices(prices);
      const remoteMeta = sanitizeRemoteModelMetadata(data);
      const feedVersion = (data && typeof data === 'object' && typeof data.version === 'string') ? data.version : 'unknown';
      const cmpToSynced = compareDatedFeedVersion(feedVersion, state.lastSyncedVersion);
      if (cmpToSynced !== null && cmpToSynced < 0) {
        throw new Error(bt('pricing.err.feed_version_older', { feedVersion, syncedVersion: state.lastSyncedVersion }));
      }
      const cmpToBuiltin = compareDatedFeedVersion(feedVersion, PRICING_METADATA.version);
      const isOlderDatedFeed = cmpToBuiltin !== null && cmpToBuiltin < 0;
      const persistedPrices = isOlderDatedFeed
        ? Object.fromEntries(Object.entries(validated).filter(([k]) => !Object.hasOwn(DEFAULT_API_PRICES, k)))
        : validated;
      resetAndRegisterRemoteModelMetadata(remoteMeta, { onlyNewEntries: isOlderDatedFeed });
      await atomicJson(remotePricingCachePath, {
        version: 1,
        syncedAt: new Date(now).toISOString(),
        sourceUrl: targetUrl,
        feedVersion,
        ...(remoteMeta.aliases ? { aliases: remoteMeta.aliases } : {}),
        ...(remoteMeta.activeModels ? { activeModels: remoteMeta.activeModels } : {}),
        ...(remoteMeta.models ? { models: remoteMeta.models } : {}),
        prices: persistedPrices,
      });
      state.lastRemoteSyncAt = now;
      state.lastCheckAt = now;
      state.nextAutoSyncAt = now + 86_400_000;
      state.lastSyncSuccess = true;
      state.lastCheckSuccess = true;
      state.lastSyncError = null;
      state.lastSyncedSourceUrl = targetUrl;
      state.lastSyncedVersion = feedVersion;
      await atomicJson(pricingSyncStatePath, {
        lastCheckAt: now,
        lastCheckSuccess: true,
        lastSyncError: null,
      }).catch(() => {});
      return { synced: true, count: Object.keys(validated).length, sourceUrl: targetUrl, version: feedVersion };
    } catch (err: any) {
      lastError = err;
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  // 所有候选源均尝试失败：保留上次成功同步时间，仅推进检查时间戳与 5 分钟重试冷却
  state.nextAutoSyncAt = now + 300_000;
  state.lastCheckAt = now;
  state.lastSyncSuccess = false;
  state.lastCheckSuccess = false;
  state.lastSyncError = lastError?.message ?? String(lastError);
  await atomicJson(pricingSyncStatePath, {
    lastCheckAt: now,
    lastCheckSuccess: false,
    lastSyncError: state.lastSyncError,
  }).catch(() => {});
  return { synced: false, error: state.lastSyncError ?? undefined };
}

export function buildPricingSyncStatus(options: {
  autoSyncEnabled: boolean;
  state: PricingSyncMutableState;
  remotePricingUrl: string;
  modelCount: number;
}) {
  const { autoSyncEnabled, state, remotePricingUrl, modelCount } = options;
  const rawVersion = state.lastSyncedVersion || PRICING_METADATA.version;
  const cmpRawToBuiltin = compareDatedFeedVersion(rawVersion, PRICING_METADATA.version);
  const effectiveVersion = cmpRawToBuiltin !== null && cmpRawToBuiltin < 0
    ? PRICING_METADATA.version
    : rawVersion;
  const effectiveCheckAt = Math.max(state.lastCheckAt, state.lastRemoteSyncAt);
  return {
    autoSyncEnabled,
    lastSyncAt: state.lastRemoteSyncAt,
    lastCheckAt: effectiveCheckAt,
    lastSyncSuccess: state.lastSyncSuccess,
    lastCheckSuccess: state.lastCheckAt ? state.lastCheckSuccess : state.lastSyncSuccess,
    lastSyncError: state.lastSyncError,
    feedVersion: effectiveVersion,
    sourceUrl: state.lastSyncedSourceUrl || remotePricingUrl,
    modelCount,
  };
}

export async function saveCustomPricingCache(
  pricingCachePath: string,
  table: Record<string, ApiPricing | ApiPricingInterval[]>
): Promise<void> {
  await atomicJson(pricingCachePath, validateRawPrices(table));
}
