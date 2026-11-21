// Ported from Enzoo404/gravitybox (MIT License) v1.1.2 — https://github.com/Enzoo404/gravitybox
// Windows adaptation: AntigravityBox project.
import { lstat, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readOptionalJson } from './files.js';
import { isRegularUserFile } from '../windows/paths.js';
import type { AccountsManager, LiveLanguageServerStatus } from './accounts.js';
import type { UsageStatsManager } from './usage.js';
import {
  normalizeCatalogTierLabel,
  resolvePricingCatalogSnapshot,
  type PricingCatalogModelInput,
  type PricingCatalogSnapshotResult,
  type PricingCatalogSourceInput,
} from './pricing.js';

const execFileAsync = promisify(execFile);
const MAX_LIVE_IDE_SNAPSHOT_MODELS = 256;

export interface LiveIdeModelSnapshotEntry {
  id: string;
  displayName: string | null;
  modelOrAlias: string | null;
  disabled: boolean;
}

export interface LiveIdeModelsSnapshot {
  schema: 1;
  appVersion: string;
  tier: string;
  observedAt: number;
  models: LiveIdeModelSnapshotEntry[];
}

export async function readInstalledAppBundleVersion(appPath: string): Promise<string> {
  if (!appPath) return '';
  // Windows: the authoritative version lives in resources/app.asar package.json.
  try {
    const { openAsarArchive } = await import('./asar.js');
    const archive = await openAsarArchive(join(appPath, 'resources', 'app.asar'), 16_000_000);
    try {
      const pkgBuf = await archive.readEntryBuffer(archive.header.files?.['package.json'], 256_000, 1);
      if (pkgBuf) {
        const pkg = JSON.parse(pkgBuf.toString('utf8'));
        if (typeof pkg?.version === 'string') return pkg.version.trim();
      }
    } finally {
      await archive.close();
    }
  } catch {
    return '';
  }
  return '';
}

export function sanitizeLiveIdeModelsSnapshot(
  live: LiveLanguageServerStatus | null | undefined,
  appVersion: string
): LiveIdeModelsSnapshot | null {
  const rawModels = live?.quota?.models;
  if (!Array.isArray(rawModels) || rawModels.length === 0) return null;
  const models: LiveIdeModelSnapshotEntry[] = [];
  for (const m of rawModels.slice(0, MAX_LIVE_IDE_SNAPSHOT_MODELS)) {
    if (!m || typeof m !== 'object') continue;
    if (m.stale === true || m.quota_source === 'carried') continue;
    const id = String(m.model_id ?? m.name ?? '').trim();
    if (!id) continue;
    const displayName = typeof m.display_name === 'string' && m.display_name.trim()
      ? m.display_name.trim()
      : null;
    const modelOrAlias = typeof m.model_or_alias === 'string' && m.model_or_alias.trim()
      ? m.model_or_alias.trim()
      : null;
    const disabled = m.disabled === true || /(?:^|[-_])disabled$/i.test(id);
    models.push({ id, displayName, modelOrAlias, disabled });
  }
  if (models.length === 0) return null;
  const tier = normalizeCatalogTierLabel(live?.tier || live?.quota?.subscription_tier || '');
  const rawObserved = live?.quota?.last_updated;
  const observedAt = typeof rawObserved === 'number' && Number.isFinite(rawObserved) && rawObserved > 0
    ? rawObserved
    : Math.floor(Date.now() / 1000);
  return {
    schema: 1,
    appVersion: String(appVersion || '').trim(),
    tier,
    observedAt,
    models,
  };
}

export async function readValidLiveIdeModelsSnapshot(
  snapshotPath: string,
  installedAppVersion: string
): Promise<LiveIdeModelsSnapshot | null> {
  const cleanInstalled = String(installedAppVersion || '').trim();
  if (!cleanInstalled) return null;
  const info = await lstat(snapshotPath).catch(() => null);
  if (!info || !isRegularUserFile(info)) {
    return null;
  }
  const data = await readOptionalJson<LiveIdeModelsSnapshot>(snapshotPath, 'live-ide-models.json');
  if (!data || typeof data !== 'object' || data.schema !== 1) return null;
  const snapVer = typeof data.appVersion === 'string' ? data.appVersion.trim() : '';
  if (!snapVer || snapVer !== cleanInstalled) return null;
  if (!Array.isArray(data.models) || data.models.length === 0) return null;
  const models: LiveIdeModelSnapshotEntry[] = [];
  for (const m of data.models.slice(0, MAX_LIVE_IDE_SNAPSHOT_MODELS)) {
    if (!m || typeof m !== 'object') continue;
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    if (!id) continue;
    models.push({
      id,
      displayName: typeof m.displayName === 'string' && m.displayName.trim() ? m.displayName.trim() : null,
      modelOrAlias: typeof m.modelOrAlias === 'string' && m.modelOrAlias.trim() ? m.modelOrAlias.trim() : null,
      disabled: m.disabled === true || /(?:^|[-_])disabled$/i.test(id),
    });
  }
  if (models.length === 0) return null;
  return {
    schema: 1,
    appVersion: snapVer,
    tier: normalizeCatalogTierLabel(data.tier),
    observedAt: typeof data.observedAt === 'number' && Number.isFinite(data.observedAt) ? data.observedAt : 0,
    models,
  };
}

export async function buildPricingCatalogPayloadSnapshot(params: {
  appPath: string;
  liveIdeModelsPath: string;
  probeLiveCached: () => Promise<LiveLanguageServerStatus | null>;
  usageManager: UsageStatsManager;
  accountsManager: AccountsManager;
}): Promise<PricingCatalogSnapshotResult> {
  const { appPath, liveIdeModelsPath, probeLiveCached, usageManager, accountsManager } = params;
  const [live, installedAppVersion, catalogRaw] = await Promise.all([
    probeLiveCached().catch(() => null),
    readInstalledAppBundleVersion(appPath),
    usageManager.getRawPricingCatalog(),
  ]);
  const liveModels = Array.isArray(live?.quota?.models) ? live.quota.models : [];
  const snapshot = liveModels.length === 0
    ? await readValidLiveIdeModelsSnapshot(liveIdeModelsPath, installedAppVersion)
    : null;
  const listRes = await accountsManager.listAccounts({ liveEmailHint: live?.email ?? null }).catch(() => null);
  const activeId = listRes?.active_account_id ?? null;
  const activeEmail = (live?.email || listRes?.active_account?.email || '').toLowerCase();
  const matchedSaved = listRes?.active_account
    ?? (activeEmail ? listRes?.accounts.find((a) => a.email.toLowerCase() === activeEmail) : undefined);

  const liveTierRaw = live?.tier || live?.quota?.subscription_tier || matchedSaved?.quota?.subscription_tier || '';
  const liveInput: PricingCatalogSourceInput | null = liveModels.length > 0
    ? { tier: liveTierRaw, source: 'live', models: liveModels as PricingCatalogModelInput[] }
    : null;
  const snapshotInput: PricingCatalogSourceInput | null = snapshot
    ? { tier: snapshot.tier, source: 'snapshot', models: snapshot.models }
    : null;

  const savedActiveAcc = listRes?.active_account;
  const activeAccountInput: PricingCatalogSourceInput | null =
    savedActiveAcc?.quota && Array.isArray(savedActiveAcc.quota.models) && savedActiveAcc.quota.models.length > 0
      ? {
          tier: savedActiveAcc.quota.subscription_tier ?? '',
          source: savedActiveAcc.quota.source ?? 'cloud',
          models: savedActiveAcc.quota.models as PricingCatalogModelInput[],
        }
      : null;

  const poolAccountsInput: PricingCatalogSourceInput[] = [];
  for (const acc of listRes?.accounts ?? []) {
    if (acc.disabled) continue;
    if (activeId && acc.id === activeId) continue;
    if (activeEmail && acc.email.toLowerCase() === activeEmail) continue;
    if (!acc.quota || acc.quota.is_forbidden) continue;
    if (!Array.isArray(acc.quota.models) || acc.quota.models.length === 0) continue;
    poolAccountsInput.push({
      tier: acc.quota.subscription_tier ?? '',
      source: acc.quota.source ?? 'cloud',
      models: acc.quota.models as PricingCatalogModelInput[],
    });
  }

  const payload = resolvePricingCatalogSnapshot({
    rawPricingTable: catalogRaw.raw,
    publicPricingKeys: catalogRaw.publicKeys,
    live: liveInput,
    snapshot: snapshotInput,
    activeAccount: activeAccountInput,
    poolAccounts: poolAccountsInput,
  });

  usageManager.setActiveOfficialModels(
    Object.keys(payload.prices),
    payload.unpricedLiveModels.map((m) => m.key)
  );
  return payload;
}
