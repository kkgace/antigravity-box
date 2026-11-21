import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsManager } from '../dist/core/accounts.js';
import {
  buildAccountQuotaOverview,
  computeAccountRemaining,
  resolveEffectiveMonitoredModel,
} from '../dist/core/account-quota.js';
import {
  projectAccountForIpcNormalized,
  projectQuotaContract,
} from '../dist/core/ipc-projections.js';
import {
  normalizeCloudModels,
  normalizeLiveModels,
} from '../dist/core/quota.js';

async function createTempManager(t) {
  const root = await mkdtemp(join(tmpdir(), 'gb-quota-tiers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new AccountsManager(root);
  manager.probeLiveLanguageServer = async () => null;
  const acc = await manager.upsertAccount({
    email: 'tier-test@example.test',
    refreshToken: 'synthetic-refresh',
    accessToken: 'synthetic-access',
    expiresIn: 3600,
  });
  return { manager, acc };
}

test('normalizeCloudModels 与 normalizeLiveModels 正确提取 quotaBucketName / quota_bucket_name', () => {
  const nowSec = 1_700_000_000;
  const reset = new Date((nowSec + 3600) * 1000).toISOString();

  const cloudModels = normalizeCloudModels({
    models: {
      'gemini-4-argon': {
        displayName: 'Gemini 4 Argon',
        quotaBucketName: 'Gemini Models',
        quotaInfo: { remainingFraction: 0.85, resetTime: reset },
      },
      'orchestrator-argon': {
        displayName: 'Orchestrator (Argon)',
        quota_bucket_name: 'Gemini Models',
        quotaInfo: { remainingFraction: 0.85, resetTime: reset },
      },
    },
  }, nowSec);
  assert.equal(cloudModels.find(m => m.model_id === 'gemini-4-argon')?.quota_bucket_name, 'Gemini Models');
  assert.equal(cloudModels.find(m => m.model_id === 'orchestrator-argon')?.quota_bucket_name, 'Gemini Models');

  const liveModels = normalizeLiveModels([
    {
      modelId: 'gemini-4-carbon',
      label: 'Gemini 4 Carbon',
      modelOrAlias: { model: 'gemini-4-carbon' },
      quotaBucketName: 'Gemini Models',
      quotaInfo: { remainingFraction: 0.85, resetTime: reset },
    },
  ], nowSec);
  assert.equal(liveModels[0]?.quota_bucket_name, 'Gemini Models');
});

test('Ultra 账号：Argon/Carbon 与 Orchestrator 归并入 Gemini 共享池，不触发 :retrieveUserQuota 与冗余告警，IPC quotaGroups 仅含核心组，智能切换解析到 Gemini 池', async t => {
  const { manager, acc } = await createTempManager(t);
  const nowMs = Date.now();
  const reset5h = new Date(nowMs + 4 * 3600 * 1000).toISOString();
  const resetWeekly = new Date(nowMs + 5 * 86400 * 1000).toISOString();
  const seenUrls = [];

  const cloudFetch = async (url) => {
    seenUrls.push(String(url));
    if (String(url).includes('loadCodeAssist')) {
      return Response.json({ currentTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } });
    }
    if (String(url).includes('fetchAvailableModels')) {
      return Response.json({
        models: {
          'gemini-2.5-pro': {
            displayName: 'Gemini 2.5 Pro',
            quotaBucketName: 'Gemini Models',
            quotaInfo: { remainingFraction: 0.85, resetTime: reset5h },
          },
          'gemini-4-argon': {
            displayName: 'Gemini 4 Argon',
            quotaBucketName: 'Gemini Models',
            quotaInfo: { remainingFraction: 0.85, resetTime: reset5h },
          },
          'gemini-4-carbon': {
            displayName: 'Gemini 4 Carbon',
            quotaBucketName: 'Gemini Models',
            quotaInfo: { remainingFraction: 0.85, resetTime: reset5h },
          },
          'orchestrator-argon': {
            displayName: 'Orchestrator (Argon)',
            quotaBucketName: 'Gemini Models',
            quotaInfo: { remainingFraction: 0.85, resetTime: reset5h },
          },
          'orchestrator-carbon': {
            displayName: 'Orchestrator (Carbon)',
            quotaBucketName: 'Gemini Models',
            quotaInfo: { remainingFraction: 0.85, resetTime: reset5h },
          },
          'claude-4-sonnet': {
            displayName: 'Claude 4 Sonnet',
            quotaBucketName: 'Claude/GPT Models',
            quotaInfo: { remainingFraction: 0.9, resetTime: reset5h },
          },
        },
      });
    }
    if (String(url).includes('retrieveUserQuotaSummary')) {
      return Response.json({
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.85, resetTime: reset5h },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.70, resetTime: resetWeekly },
            ],
          },
          {
            displayName: 'Claude/GPT Models',
            buckets: [
              { bucketId: 'claude-5h', window: '5h', remainingFraction: 0.90, resetTime: reset5h },
              { bucketId: 'claude-weekly', window: 'weekly', remainingFraction: 0.80, resetTime: resetWeekly },
            ],
          },
        ],
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const refreshed = await manager.refreshQuota(acc.id, cloudFetch);
  assert.equal(seenUrls.some(u => u.includes('retrieveUserQuota') && !u.includes('Summary')), false);

  const overview = manager.getAccountQuotaOverview(refreshed);
  assert.equal(overview.argonStatus.mode, 'unified');
  assert.equal(overview.argonStatus.pooledInFamily, 'gemini');
  assert.equal(overview.argonStatus.availability, 'available');
  assert.equal(overview.carbonStatus.mode, 'unified');
  assert.equal(overview.carbonStatus.pooledInFamily, 'gemini');
  assert.deepEqual(overview.standaloneModels, []);
  assert.equal(overview.refreshState.missingFamilies.includes('argon'), false);
  assert.equal(overview.refreshState.missingFamilies.includes('carbon'), false);
  for (const forbidden of ['ARGON_MODEL_QUOTA', 'ARGON_UNKNOWN', 'MISSING_FAMILY:argon', 'MISSING_FAMILY:carbon']) {
    assert.equal(overview.quotaWarningCodes.includes(forbidden), false, `unexpected warning ${forbidden}`);
  }

  // 智能切换 remaining 解析
  assert.equal(computeAccountRemaining(refreshed, 'argon'), 70);
  assert.equal(computeAccountRemaining(refreshed, 'carbon'), 70);
  assert.equal(computeAccountRemaining(refreshed, 'gemini-4-argon'), 70);
  assert.equal(computeAccountRemaining(refreshed, 'gemini-4-carbon'), 70);
  assert.equal(computeAccountRemaining(refreshed, 'orchestrator-argon'), 70);
  assert.equal(computeAccountRemaining(refreshed, 'gemini_all'), 70);
  assert.equal(computeAccountRemaining(refreshed, 'gemini'), 70);
  assert.equal(computeAccountRemaining(refreshed, 'claude'), 80);
  assert.equal(computeAccountRemaining(refreshed, 'all'), 70);

  // IPC 动态 quotaGroups 契约
  const ipcContract = projectQuotaContract(overview);
  assert.deepEqual(ipcContract.quotaGroups.map(g => g.key), ['gemini', 'claude']);
  const ipcAccount = projectAccountForIpcNormalized(refreshed, manager, { includeOverviewFields: true });
  assert.deepEqual(ipcAccount.quotaGroups.map(g => g.key), ['gemini', 'claude']);
  assert.equal(ipcAccount.quotaGroups[0].displayName, 'Gemini');
  assert.equal(ipcAccount.quotaGroups[0].summaryLabel, 'Gemini');
  assert.deepEqual(ipcAccount.quotaGroups[0].brands, ['gemini']);
  assert.equal(ipcAccount.quotaGroups[0].isStandalone, false);
  assert.equal(ipcAccount.quotaGroups[0].availability, 'available');
  assert.equal(ipcAccount.quotaGroups[0].quotaState, 'known');
  assert.deepEqual(ipcAccount.quotaGroups[0].windows.map(w => w.period), ['5h', 'weekly']);
  assert.equal(ipcAccount.quotaGroups[1].key, 'claude');
  assert.equal(ipcAccount.quotaGroups[1].displayName, 'Claude/GPT');
  assert.deepEqual(ipcAccount.quotaGroups[1].brands, ['claude', 'gpt']);
  // 原始 stored quota.quota_groups 保持完整兼容
  assert.equal(Array.isArray(ipcAccount.quota.quota_groups), true);
  assert.equal(ipcAccount.quota.quota_groups.length, 2);
});

test('Pro 账号：独立 Gemini 4 Argon 每周组保留为 standalone 与动态 quotaGroups，且不产生虚假 Carbon 行', async t => {
  const { manager, acc } = await createTempManager(t);
  const nowMs = Date.now();
  const reset5h = new Date(nowMs + 3 * 3600 * 1000).toISOString();
  const resetWeekly = new Date(nowMs + 6 * 86400 * 1000).toISOString();

  const cloudFetch = async (url) => {
    if (String(url).includes('loadCodeAssist')) {
      return Response.json({ currentTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } });
    }
    if (String(url).includes('fetchAvailableModels')) {
      return Response.json({
        models: {
          'gemini-2.5-pro': {
            displayName: 'Gemini 2.5 Pro',
            quotaInfo: { remainingFraction: 0.75, resetTime: reset5h },
          },
          'gemini-4-argon': {
            displayName: 'Gemini 4 Argon',
            quotaBucketName: 'Gemini 4 Argon',
            quotaInfo: { remainingFraction: 0.40, resetTime: resetWeekly },
          },
          'claude-4-sonnet': {
            displayName: 'Claude 4 Sonnet',
            quotaInfo: { remainingFraction: 0.90, resetTime: reset5h },
          },
        },
      });
    }
    return Response.json({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.75, resetTime: reset5h }],
        },
        {
          displayName: 'Claude/GPT Models',
          buckets: [{ bucketId: 'claude-5h', window: '5h', remainingFraction: 0.90, resetTime: reset5h }],
        },
        {
          displayName: 'Gemini 4 Argon',
          buckets: [{ bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 0.40, resetTime: resetWeekly }],
        },
      ],
    });
  };

  const refreshed = await manager.refreshQuota(acc.id, cloudFetch);
  const overview = manager.getAccountQuotaOverview(refreshed);
  assert.equal(overview.argonStatus.mode, 'standalone');
  assert.equal(overview.argonStatus.pooledInFamily, null);
  assert.equal(overview.argonStatus.period, 'weekly');
  assert.equal(overview.argonStatus.remaining, 0.4);
  assert.deepEqual(overview.standaloneModels.map(m => m.key), ['argon']);
  assert.deepEqual(overview.projectedQuotaGroups.map(g => g.key), ['gemini', 'claude', 'argon']);
  const argonGroup = overview.projectedQuotaGroups.find(g => g.key === 'argon');
  assert.equal(argonGroup.isStandalone, true);
  assert.equal(argonGroup.summaryLabel, 'Argon');
  assert.deepEqual(argonGroup.brands, ['gemini']);
  assert.equal(argonGroup.windows[0].period, 'weekly');
  assert.equal(argonGroup.windows[0].remaining, 0.4);

  assert.equal(computeAccountRemaining(refreshed, 'argon'), 40);
  assert.equal(computeAccountRemaining(refreshed, 'gemini'), 75);
});

test('Free / Starter 账号：disabled Argon 隐藏且不触发 :retrieveUserQuota，starter 映射为 FREE', async t => {
  const { manager, acc } = await createTempManager(t);
  const nowMs = Date.now();
  const reset5h = new Date(nowMs + 2 * 3600 * 1000).toISOString();
  const seenUrls = [];

  const cloudFetch = async (url) => {
    seenUrls.push(String(url));
    if (String(url).includes('loadCodeAssist')) {
      return Response.json({ currentTier: { id: 'starter', name: 'Antigravity Starter Quota' } });
    }
    if (String(url).includes('fetchAvailableModels')) {
      return Response.json({
        models: {
          'gemini-2.5-flash': {
            displayName: 'Gemini 2.5 Flash',
            quotaInfo: { remainingFraction: 0.95, resetTime: reset5h },
          },
          'gemini-4-argon-disabled': {
            displayName: 'Gemini 4 Argon',
            disabled: true,
          },
          'orchestrator-argon-disabled': {
            displayName: 'Orchestrator (Argon)',
            disabled: true,
          },
          'claude-4-sonnet': {
            displayName: 'Claude 4 Sonnet',
            quotaInfo: { remainingFraction: 0.5, resetTime: reset5h },
          },
        },
      });
    }
    return Response.json({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.95, resetTime: reset5h }],
        },
        {
          displayName: 'Claude/GPT Models',
          buckets: [{ bucketId: 'claude-5h', window: '5h', remainingFraction: 0.5, resetTime: reset5h }],
        },
      ],
    });
  };

  const refreshed = await manager.refreshQuota(acc.id, cloudFetch);
  assert.equal(seenUrls.some(u => u.includes('retrieveUserQuota') && !u.includes('Summary')), false);

  const overview = manager.getAccountQuotaOverview(refreshed);
  assert.equal(overview.subscriptionTier, 'FREE');
  assert.equal(overview.argonStatus.availability, 'disabled');
  assert.equal(overview.argonStatus.mode, 'disabled');
  assert.deepEqual(overview.standaloneModels, []);
  assert.deepEqual(overview.projectedQuotaGroups.map(g => g.key), ['gemini', 'claude']);
  for (const forbidden of ['ARGON_MODEL_QUOTA', 'ARGON_UNKNOWN', 'MISSING_FAMILY:argon', 'MISSING_FAMILY:carbon']) {
    assert.equal(overview.quotaWarningCodes.includes(forbidden), false);
  }
  const ipcAccount = projectAccountForIpcNormalized(refreshed, manager, { includeOverviewFields: true });
  assert.equal(ipcAccount.subscription_tier, 'FREE');
  assert.deepEqual(ipcAccount.quotaGroups.map(g => g.key), ['gemini', 'claude']);
});

test('旧快照中遗留的 ARGON_MODEL_QUOTA / MISSING_FAMILY:argon 在 unified 模式下自动收敛，真实独立模型仍保留', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const reset = new Date((nowSec + 3600) * 1000).toISOString();
  const overview = buildAccountQuotaOverview({
    quota: {
      subscription_tier: 'ULTRA',
      last_updated: nowSec,
      is_forbidden: false,
      model_forwarding_rules: {},
      quota_warnings: [
        'ARGON_MODEL_QUOTA: legacy warning',
        'MISSING_FAMILY:argon: missing argon',
      ],
      quota_groups: [
        {
          display_name: 'Gemini Models',
          family: 'gemini',
          buckets: [{ bucket_id: 'g5h', window: '5h', remaining_fraction: 0.85, remaining_fraction_known: true, reset_time: reset }],
        },
      ],
      models: [
        { name: 'gemini-4-argon', model_id: 'gemini-4-argon', display_name: 'Gemini 4 Argon', family: 'argon', is_argon: true, quota_bucket_name: 'Gemini Models', percentage: 85, percentage_known: true, own_percentage: 85, own_percentage_known: true, own_reset_time: reset, reset_time: reset },
        { name: 'gemini-4-xenon', model_id: 'gemini-4-xenon', display_name: 'Gemini 4 Xenon', family: 'other', percentage: 42, percentage_known: true, own_percentage: 42, own_percentage_known: true, own_reset_time: reset, reset_time: reset },
      ],
    },
  });

  assert.equal(overview.argonStatus.mode, 'unified');
  assert.equal(overview.quotaWarningCodes.includes('ARGON_MODEL_QUOTA'), false);
  assert.equal(overview.quotaWarningCodes.includes('MISSING_FAMILY:argon'), false);
  assert.deepEqual(overview.standaloneModels.map(m => m.key), ['gemini-4-xenon']);
  assert.deepEqual(overview.projectedQuotaGroups.map(g => g.key), ['gemini', 'gemini-4-xenon']);
  assert.deepEqual(overview.projectedQuotaGroups.find(g => g.key === 'gemini-4-xenon')?.brands, ['gemini']);
});

test('P1-4 & P1-5: All Gemini Models 策略兼容与 common.period.daily 双语词条完整对齐', async () => {
  const { translate } = await import('../dist/core/i18n.js');
  assert.equal(translate('en', 'common.period.daily', undefined, { namespace: 'app' }), 'Daily');
  assert.equal(translate('zh-Hans', 'common.period.daily', undefined, { namespace: 'app' }), '每日');

  const nowSec = Math.floor(Date.now() / 1000);
  const reset = new Date((nowSec + 3600) * 1000).toISOString();
  const account = {
    quota: {
      subscription_tier: 'PRO',
      last_updated: nowSec,
      is_forbidden: false,
      model_forwarding_rules: {},
      quota_groups: [
        {
          display_name: 'Gemini Models',
          family: 'gemini',
          buckets: [{ bucket_id: 'g-5h', window: '5h', remaining_fraction: 0.65, remaining_fraction_known: true, reset_time: reset }],
        },
        {
          display_name: 'Gemini 4 Argon',
          family: 'argon',
          buckets: [{ bucket_id: 'a-weekly', window: 'weekly', remaining_fraction: 0.40, remaining_fraction_known: true, reset_time: reset }],
        },
        {
          display_name: 'Claude/GPT Models',
          family: 'claude',
          buckets: [{ bucket_id: 'c-5h', window: '5h', remaining_fraction: 0.25, remaining_fraction_known: true, reset_time: reset }],
        },
      ],
      models: [
        { name: 'gemini-2.5-pro', model_id: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', family: 'gemini', percentage: 65, percentage_known: true, own_percentage: 65, own_percentage_known: true, own_reset_time: reset, reset_time: reset },
        { name: 'gemini-4-argon', model_id: 'gemini-4-argon', display_name: 'Gemini 4 Argon', family: 'argon', is_argon: true, quota_bucket_name: 'Gemini 4 Argon', percentage: 40, percentage_known: true, own_percentage: 40, own_percentage_known: true, own_reset_time: reset, reset_time: reset },
        { name: 'claude-4-sonnet', model_id: 'claude-4-sonnet', display_name: 'Claude 4 Sonnet', family: 'claude', percentage: 25, percentage_known: true, own_percentage: 25, own_percentage_known: true, own_reset_time: reset, reset_time: reset },
      ],
    },
  };
  assert.equal(computeAccountRemaining(account, 'All Gemini Models'), 40);
  assert.equal(computeAccountRemaining(account, 'gemini_all'), 40);
  assert.equal(computeAccountRemaining(account, 'Gemini 全系模型'), 40);
  assert.equal(computeAccountRemaining(account, 'all'), 25);
});

test('Ultra 账号实机双接口漂移回归：120s 满额重置偏移、对话百分比滞后防误吸 Claude、独立模型保真与 Live 套餐防降级', async t => {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const reset5hModel = new Date(nowMs + 5 * 3600 * 1000).toISOString();
  const reset5hGroup = new Date(nowMs + 5 * 3600 * 1000 + 120_000).toISOString();
  const resetWeekly = new Date(nowMs + 6 * 86400 * 1000).toISOString();
  const reset7d = new Date(nowMs + 7 * 86400 * 1000).toISOString();

  // 场景 A：复刻实机 100% 满额浮动 5h 窗口 120s 重置时间漂移 & quota_bucket_name 为 null
  const driftedFullAccount = {
    quota: {
      subscription_tier: 'ULTRA',
      source: 'live',
      last_updated: nowSec,
      is_forbidden: false,
      model_forwarding_rules: {},
      quota_groups: [
        {
          display_name: 'Gemini Models',
          family: 'gemini',
          source: 'live',
          buckets: [
            { bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 1, remaining_fraction_known: true, reset_time: reset5hGroup, observed_at: nowSec, source: 'live' },
            { bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.88, remaining_fraction_known: true, reset_time: resetWeekly, observed_at: nowSec, source: 'live' },
          ],
        },
        {
          display_name: 'Claude and GPT models',
          family: 'claude',
          source: 'live',
          buckets: [
            { bucket_id: '3p-5h', window: '5h', remaining_fraction: 1, remaining_fraction_known: true, reset_time: reset5hGroup, observed_at: nowSec, source: 'live' },
            { bucket_id: '3p-weekly', window: 'weekly', remaining_fraction: 1, remaining_fraction_known: true, reset_time: reset7d, observed_at: nowSec, source: 'live' },
          ],
        },
      ],
      models: [
        'gemini-4-argon-high',
        'gemini-4-argon-medium',
        'gemini-4-argon-low',
        'gemini-4-carbon-high',
        'gemini-4-carbon-medium',
        'gemini-4-carbon-low',
        'gemini-pro-orchestrator',
        'gemini-pro-orchestrator-argon',
        'gemini-4-hydrogen-high',
        'gemini-3.8-flash-high',
      ].map(id => ({
        name: id,
        model_id: id,
        display_name: id === 'gemini-pro-orchestrator'
          ? 'Orchestrator (Carbon)'
          : id === 'gemini-pro-orchestrator-argon'
            ? 'Orchestrator (Argon)'
            : id,
        quota_bucket_name: null,
        percentage: 100,
        percentage_known: true,
        own_percentage: 100,
        own_percentage_known: true,
        own_reset_time: reset5hModel,
        own_observed_at: nowSec,
        reset_time: reset5hModel,
        quota_source: 'live',
      })),
    },
  };

  const driftedOverview = buildAccountQuotaOverview(driftedFullAccount, { nowMs });
  assert.equal(driftedOverview.argonStatus.mode, 'unified');
  assert.equal(driftedOverview.carbonStatus.mode, 'unified');
  assert.equal(driftedOverview.argonStatus.pooledInFamily, 'gemini');
  assert.equal(driftedOverview.carbonStatus.pooledInFamily, 'gemini');
  assert.deepEqual(driftedOverview.standaloneModels, []);
  assert.deepEqual(driftedOverview.projectedQuotaGroups.map(g => g.key), ['gemini', 'claude']);

  // 场景 B：对话消耗期间 GetUserStatus 百分比滞后 + 跨品牌防误吸 Claude/GPT
  const reset4hGemini = new Date(nowMs + 4 * 3600 * 1000).toISOString();
  const reset5hClaudeNear = new Date(nowMs + 5 * 3600 * 1000 + 20_000).toISOString();
  const laggedConsumptionAccount = {
    quota: {
      subscription_tier: 'ULTRA',
      source: 'live',
      last_updated: nowSec,
      is_forbidden: false,
      model_forwarding_rules: {},
      quota_groups: [
        {
          display_name: 'Gemini Models',
          family: 'gemini',
          source: 'live',
          buckets: [
            { bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 0.93, remaining_fraction_known: true, reset_time: reset4hGemini, observed_at: nowSec, source: 'live' },
            { bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.88, remaining_fraction_known: true, reset_time: resetWeekly, observed_at: nowSec, source: 'live' },
          ],
        },
        {
          display_name: 'Claude and GPT models',
          family: 'claude',
          source: 'live',
          buckets: [
            { bucket_id: '3p-5h', window: '5h', remaining_fraction: 1, remaining_fraction_known: true, reset_time: reset5hClaudeNear, observed_at: nowSec, source: 'live' },
            { bucket_id: '3p-weekly', window: 'weekly', remaining_fraction: 1, remaining_fraction_known: true, reset_time: reset7d, observed_at: nowSec, source: 'live' },
          ],
        },
      ],
      models: [
        { name: 'gemini-4-argon-high', model_id: 'gemini-4-argon-high', display_name: 'Gemini 4 Argon (High)', quota_bucket_name: null, percentage: 100, percentage_known: true, own_percentage: 100, own_percentage_known: true, own_reset_time: reset5hModel, own_observed_at: nowSec, reset_time: reset5hModel, quota_source: 'live' },
        { name: 'gemini-4-carbon-high', model_id: 'gemini-4-carbon-high', display_name: 'Gemini 4 Carbon (High)', quota_bucket_name: null, percentage: 100, percentage_known: true, own_percentage: 100, own_percentage_known: true, own_reset_time: reset5hModel, own_observed_at: nowSec, reset_time: reset5hModel, quota_source: 'live' },
        { name: 'gemini-pro-orchestrator', model_id: 'gemini-pro-orchestrator', display_name: 'Orchestrator (Carbon)', quota_bucket_name: null, percentage: 100, percentage_known: true, own_percentage: 100, own_percentage_known: true, own_reset_time: reset5hModel, own_observed_at: nowSec, reset_time: reset5hModel, quota_source: 'live' },
        { name: 'gemini-pro-orchestrator-argon', model_id: 'gemini-pro-orchestrator-argon', display_name: 'Orchestrator (Argon)', quota_bucket_name: null, percentage: 100, percentage_known: true, own_percentage: 100, own_percentage_known: true, own_reset_time: reset5hModel, own_observed_at: nowSec, reset_time: reset5hModel, quota_source: 'live' },
        { name: 'gemini-3.8-flash-high', model_id: 'gemini-3.8-flash-high', display_name: 'Gemini 3.8 Flash (High)', quota_bucket_name: null, percentage: 100, percentage_known: true, own_percentage: 100, own_percentage_known: true, own_reset_time: reset5hModel, own_observed_at: nowSec, reset_time: reset5hModel, quota_source: 'live' },
      ],
    },
  };

  const laggedOverview = buildAccountQuotaOverview(laggedConsumptionAccount, { nowMs });
  assert.equal(laggedOverview.argonStatus.mode, 'unified');
  assert.equal(laggedOverview.carbonStatus.mode, 'unified');
  assert.equal(laggedOverview.argonStatus.pooledInFamily, 'gemini');
  assert.equal(laggedOverview.carbonStatus.pooledInFamily, 'gemini');
  assert.deepEqual(laggedOverview.standaloneModels, []);
  assert.deepEqual(laggedOverview.projectedQuotaGroups.map(g => g.key), ['gemini', 'claude']);
  assert.equal(computeAccountRemaining(laggedConsumptionAccount, 'argon'), 88);
  assert.equal(computeAccountRemaining(laggedConsumptionAccount, 'carbon'), 88);

  // 场景 C：显式独立 quota_bucket_name 与真实独立模型不被误吞并
  const independentUltraAccount = {
    quota: {
      subscription_tier: 'ULTRA',
      source: 'cloud',
      last_updated: nowSec,
      is_forbidden: false,
      model_forwarding_rules: {},
      quota_groups: [
        {
          display_name: 'Gemini Models',
          family: 'gemini',
          source: 'cloud',
          buckets: [
            { bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.88, remaining_fraction_known: true, reset_time: resetWeekly, observed_at: nowSec, source: 'cloud' },
          ],
        },
      ],
      models: [
        { name: 'gemini-3.8-flash-high', model_id: 'gemini-3.8-flash-high', display_name: 'Gemini 3.8 Flash (High)', family: 'gemini', percentage: 88, percentage_known: true, own_percentage: 88, own_percentage_known: true, own_reset_time: resetWeekly, own_observed_at: nowSec, reset_time: resetWeekly, quota_source: 'cloud' },
        { name: 'gemini-4-argon', model_id: 'gemini-4-argon', display_name: 'Gemini 4 Argon', family: 'argon', is_argon: true, quota_bucket_name: 'Gemini 4 Argon', percentage: 88, percentage_known: true, own_percentage: 88, own_percentage_known: true, own_reset_time: resetWeekly, own_observed_at: nowSec, reset_time: resetWeekly, quota_source: 'cloud' },
        { name: 'gemini-4-carbon', model_id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon', family: 'carbon', is_carbon: true, quota_bucket_name: null, percentage: 55, percentage_known: true, own_percentage: 55, own_percentage_known: true, own_reset_time: reset7d, own_observed_at: nowSec, reset_time: reset7d, quota_source: 'cloud' },
        { name: 'gemini-4-xenon', model_id: 'gemini-4-xenon', display_name: 'Gemini 4 Xenon', family: 'other', quota_bucket_name: null, percentage: 42, percentage_known: true, own_percentage: 42, own_percentage_known: true, own_reset_time: reset7d, own_observed_at: nowSec, reset_time: reset7d, quota_source: 'cloud' },
      ],
    },
  };

  const independentOverview = buildAccountQuotaOverview(independentUltraAccount, { nowMs });
  assert.equal(independentOverview.argonStatus.mode, 'standalone');
  assert.equal(independentOverview.carbonStatus.mode, 'standalone');
  assert.deepEqual(independentOverview.standaloneModels.map(m => m.key), ['argon', 'carbon', 'gemini-4-xenon']);

  // 场景 D：Live 探测瞬态未返回套餐时，落盘保持已保存的 ULTRA，不降级丢失
  const { manager, acc } = await createTempManager(t);
  acc.quota = {
    ...driftedFullAccount.quota,
    subscription_tier: 'ULTRA',
  };
  await manager.saveAccount(acc);

  manager.probeLiveLanguageServer = async () => ({
    email: acc.email,
    name: 'Ultra User',
    tier: '',
    quota: {
      ...driftedFullAccount.quota,
      subscription_tier: '',
      refresh_state: {
        complete: true,
        endpointsAttempted: ['live:GetUserStatus', 'live:RetrieveUserQuotaSummary'],
        endpointsSucceeded: ['live:GetUserStatus', 'live:RetrieveUserQuotaSummary'],
        missingFamilies: [],
        missingWindows: [],
        carriedGroups: 0,
        refreshedAt: nowSec,
      },
    },
  });

  const refreshed = await manager.refreshQuota(acc.id, async () => {
    throw new Error('unexpected cloud fallback');
  });
  assert.equal(refreshed.quota?.subscription_tier, 'ULTRA');
  const refreshedOverview = manager.getAccountQuotaOverview(refreshed, { nowMs });
  assert.equal(refreshedOverview.subscriptionTier, 'ULTRA');
  assert.equal(refreshedOverview.argonStatus.mode, 'unified');
  assert.equal(refreshedOverview.carbonStatus.mode, 'unified');
  assert.deepEqual(refreshedOverview.standaloneModels, []);
});

test('跨套餐智能切换推荐自适应：配置 argon 时在 Pro 监测独立 Argon，切到 Free 耗尽时自动兜底基础 Gemini 防瘫痪，切到 Ultra 映射共享池', async t => {
  const { manager, acc: ultraAcc } = await createTempManager(t);
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = nowSec * 1000;
  const reset5h = new Date(nowMs + 4 * 3600 * 1000).toISOString();
  const resetWeekly = new Date(nowMs + 5 * 86400 * 1000).toISOString();

  // 1) Ultra 账号：Argon 并入 Gemini 共享池 (85%)
  ultraAcc.email = 'ultra-adaptive@example.test';
  ultraAcc.quota = {
    subscription_tier: 'ULTRA',
    source: 'cloud',
    last_updated: nowSec,
    is_forbidden: false,
    model_forwarding_rules: {},
    quota_groups: [
      {
        display_name: 'Gemini Models',
        family: 'gemini',
        buckets: [
          { bucket_id: 'g-5h', window: '5h', remaining_fraction: 0.85, remaining_fraction_known: true, reset_time: reset5h, observed_at: nowSec, source: 'cloud' },
          { bucket_id: 'g-wk', window: 'weekly', remaining_fraction: 0.85, remaining_fraction_known: true, reset_time: resetWeekly, observed_at: nowSec, source: 'cloud' },
        ],
      },
      {
        display_name: 'Claude/GPT Models',
        family: 'claude',
        buckets: [
          { bucket_id: 'c-5h', window: '5h', remaining_fraction: 0.90, remaining_fraction_known: true, reset_time: reset5h, observed_at: nowSec, source: 'cloud' },
        ],
      },
    ],
    models: [
      { name: 'gemini-3.8-flash', model_id: 'gemini-3.8-flash', family: 'gemini', percentage: 85, percentage_known: true, own_percentage: 85, own_percentage_known: true, own_reset_time: reset5h, own_observed_at: nowSec, reset_time: reset5h },
      { name: 'gemini-4-argon', model_id: 'gemini-4-argon', family: 'argon', is_argon: true, percentage: 85, percentage_known: true, own_percentage: 85, own_percentage_known: true, own_reset_time: reset5h, own_observed_at: nowSec, reset_time: reset5h },
    ],
  };
  await manager.saveAccount(ultraAcc);

  // 2) Pro 账号：基础 Gemini 充足 (80%)，独立 Argon 耗尽偏低 (5%)
  const proAcc = await manager.upsertAccount({
    email: 'pro-adaptive@example.test',
    refreshToken: 'synthetic-refresh-pro',
    accessToken: 'synthetic-access-pro',
    expiresIn: 3600,
  });
  proAcc.quota = {
    subscription_tier: 'PRO',
    source: 'cloud',
    last_updated: nowSec,
    is_forbidden: false,
    model_forwarding_rules: {},
    quota_groups: [
      {
        display_name: 'Gemini Models',
        family: 'gemini',
        buckets: [{ bucket_id: 'g-5h', window: '5h', remaining_fraction: 0.80, remaining_fraction_known: true, reset_time: reset5h, observed_at: nowSec, source: 'cloud' }],
      },
      {
        display_name: 'Gemini 4 Argon',
        family: 'argon',
        buckets: [{ bucket_id: 'a-wk', window: 'weekly', remaining_fraction: 0.05, remaining_fraction_known: true, reset_time: resetWeekly, observed_at: nowSec, source: 'cloud' }],
      },
    ],
    models: [
      { name: 'gemini-3.8-flash', model_id: 'gemini-3.8-flash', family: 'gemini', percentage: 80, percentage_known: true, own_percentage: 80, own_percentage_known: true, own_reset_time: reset5h, own_observed_at: nowSec, reset_time: reset5h },
      { name: 'gemini-4-argon', model_id: 'gemini-4-argon', family: 'argon', is_argon: true, quota_bucket_name: 'Gemini 4 Argon', percentage: 5, percentage_known: true, own_percentage: 5, own_percentage_known: true, own_reset_time: resetWeekly, own_observed_at: nowSec, reset_time: resetWeekly },
    ],
  };
  await manager.saveAccount(proAcc);

  // 3) Free 账号：基础 Gemini 耗尽偏低 (5%)，Argon 禁用
  const freeAcc = await manager.upsertAccount({
    email: 'free-adaptive@example.test',
    refreshToken: 'synthetic-refresh-free',
    accessToken: 'synthetic-access-free',
    expiresIn: 3600,
  });
  freeAcc.quota = {
    subscription_tier: 'FREE',
    source: 'cloud',
    last_updated: nowSec,
    is_forbidden: false,
    model_forwarding_rules: {},
    quota_groups: [
      {
        display_name: 'Gemini Models',
        family: 'gemini',
        buckets: [{ bucket_id: 'g-wk', window: 'weekly', remaining_fraction: 0.05, remaining_fraction_known: true, reset_time: resetWeekly, observed_at: nowSec, source: 'cloud' }],
      },
    ],
    models: [
      { name: 'gemini-3.8-flash', model_id: 'gemini-3.8-flash', family: 'gemini', percentage: 5, percentage_known: true, own_percentage: 5, own_percentage_known: true, own_reset_time: resetWeekly, own_observed_at: nowSec, reset_time: resetWeekly },
      { name: 'gemini-4-argon-disabled', model_id: 'gemini-4-argon-disabled', family: 'argon', is_argon: true, disabled: true, percentage: 0, percentage_known: false, reset_time: '' },
    ],
  };
  await manager.saveAccount(freeAcc);

  // 保存策略为 monitored_model: 'argon'
  await manager.setAutoSwitchConfig({
    enabled: true,
    strategy: 'priority',
    reserve_percentage: 10,
    candidate_min_percentage: 30,
    monitored_model: 'argon',
  });

  // 场景 1：当前激活为 Pro -> 保持监测 argon (5%) 并推荐 Ultra 候选（排除 Argon 禁用的 Free）
  assert.equal(resolveEffectiveMonitoredModel(proAcc, 'argon'), 'argon');
  await manager.setCurrentAccount(proAcc.id);
  const proRec = await manager.selectBestAccount();
  assert.equal(proRec.shouldSwitch, true);
  assert.equal(proRec.bestCandidate?.id, ultraAcc.id);

  // 场景 2：切换到 Free -> 自动兜底为 gemini (5%)，仍正常触发推荐而不静默瘫痪
  assert.equal(resolveEffectiveMonitoredModel(freeAcc, 'argon'), 'gemini');
  assert.equal(resolveEffectiveMonitoredModel(freeAcc, 'gemini_all'), 'gemini');
  await manager.setCurrentAccount(freeAcc.id);
  const freeRec = await manager.selectBestAccount();
  assert.equal(freeRec.shouldSwitch, true);
  assert.equal(freeRec.bestCandidate?.id, ultraAcc.id);

  // 场景 3：切换到 Ultra -> 自动映射为 gemini (85%)，充足不误触发切换
  assert.equal(resolveEffectiveMonitoredModel(ultraAcc, 'argon'), 'gemini');
  assert.equal(resolveEffectiveMonitoredModel(ultraAcc, 'gemini_all'), 'gemini');
  await manager.setCurrentAccount(ultraAcc.id);
  const ultraRec = await manager.selectBestAccount();
  assert.equal(ultraRec.shouldSwitch, false);

  // 原持久化的 monitored_model 保持 'argon' 未被破坏性覆写
  assert.equal((await manager.getAutoSwitchConfig()).monitored_model, 'argon');
});

test('Google AI Ultra 账号 ("Ultra User" ultra@example.invalid) 实机 GetUserStatus 与 loadCodeAssist 回归：planInfo.planName="Pro" 不得覆盖 userTier="g1-ultra-tier"', async t => {
  const { resolveProbeSubscriptionTier } = await import('../dist/core/account-probe.js');

  // 1. GetUserStatus 实机载荷：planStatus.planInfo.planName 为 "Pro"，真实 Ultra 身份在 userTier / g1Tier
  assert.equal(
    resolveProbeSubscriptionTier({
      email: 'ultra@example.invalid',
      name: 'Ultra User',
      planStatus: { planInfo: { planName: 'Pro', teamsTier: 'TEAMS_TIER_PRO' } },
      userTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra', description: 'Google AI Ultra' },
    }),
    'ULTRA'
  );
  assert.equal(
    resolveProbeSubscriptionTier({
      email: 'ultra@example.invalid',
      planStatus: { planInfo: { planName: 'Pro' } },
      g1Tier: 'g1-ultra-tier',
    }),
    'ULTRA'
  );
  // 真实 Pro 账号保持 PRO
  assert.equal(
    resolveProbeSubscriptionTier({
      email: 'pro@example.test',
      planStatus: { planInfo: { planName: 'Pro' } },
      userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
    }),
    'PRO'
  );
  // 企业 Vertex AI 账号保持 ENTERPRISE
  assert.equal(
    resolveProbeSubscriptionTier({
      email: 'corp@example.test',
      planStatus: { planInfo: { planName: 'Enterprise' } },
      userTier: { id: 'agy-business-paygo-tier', name: 'Antigravity Agent Platform', usesGcpTos: true },
    }),
    'ENTERPRISE'
  );

  // 2. loadCodeAssist 中 name="Pro" 但 id="g1-ultra-tier" 时仍识别为 ULTRA
  const { manager, acc } = await createTempManager(t);
  const reset5h = new Date(Date.now() + 3600 * 1000).toISOString();
  const refreshed = await manager.refreshQuota(acc.id, async (url) => {
    if (String(url).includes('loadCodeAssist')) {
      return Response.json({
        currentTier: { id: 'g1-ultra-tier', name: 'Pro' },
      });
    }
    if (String(url).includes('fetchAvailableModels')) {
      return Response.json({
        models: {
          'gemini-4-carbon': {
            displayName: 'Gemini 4 Carbon',
            quotaBucketName: 'Gemini Models',
            quotaInfo: { remainingFraction: 1, resetTime: reset5h },
          },
        },
      });
    }
    return Response.json({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [{ bucketId: 'g-5h', window: '5h', remainingFraction: 1, resetTime: reset5h }],
        },
      ],
    });
  });
  const overview = manager.getAccountQuotaOverview(refreshed);
  assert.equal(overview.carbonStatus.mode, 'unified');
  const ipcAccount = projectAccountForIpcNormalized(refreshed, manager, { includeOverviewFields: true });
  assert.equal(ipcAccount.subscription_tier, 'ULTRA');
  assert.equal(ipcAccount.quota.subscription_tier, 'ULTRA');
});

test('P0-04 & P1-16 & P2-20: 订阅到期 PRO/ULTRA->FREE 真实降级同步、残缺探测防误降级、摘要态凭据就绪与新一代 3P 家族归类', async t => {
  const { mergeSubscriptionTier } = await import('../dist/core/account-probe.js');
  const { projectAccountForIpc } = await import('../dist/core/account-quota.js');

  // 1) mergeSubscriptionTier 单元契约
  assert.equal(mergeSubscriptionTier('FREE', 'PRO', true), 'FREE', '完整探测确认降级为 FREE 时必须更新为 FREE');
  assert.equal(mergeSubscriptionTier('FREE', 'ULTRA', true), 'FREE', '完整探测确认 ULTRA 到期降级为 FREE 时必须更新为 FREE');
  assert.equal(mergeSubscriptionTier('FREE', 'PRO', false), 'PRO', '残缺探测临时回落 FREE 时保留已验证历史等级 PRO');
  assert.equal(mergeSubscriptionTier('', 'ULTRA', true), 'ULTRA', '未返回套餐字段时保留历史等级 ULTRA');
  assert.equal(mergeSubscriptionTier('PRO', 'ULTRA', true), 'PRO', 'ULTRA 降为 PRO 时同步更新为 PRO');

  // 2) AccountsManager.refreshQuota 端到端降级验证：曾为 ULTRA 的账号到期变为 Starter/Free 后，徽章与配额视图必须同步为 FREE
  const { manager, acc } = await createTempManager(t);
  const reset5h = new Date(Date.now() + 3600 * 1000).toISOString();
  acc.quota = {
    subscription_tier: 'ULTRA',
    source: 'cloud',
    last_updated: Math.floor(Date.now() / 1000) - 600,
    is_forbidden: false,
    model_forwarding_rules: {},
    models: [],
  };
  await manager.saveAccount(acc);

  const downgraded = await manager.refreshQuota(acc.id, async (url) => {
    if (String(url).includes('loadCodeAssist')) {
      return Response.json({ currentTier: { id: 'g1-free-tier', name: 'Free' } });
    }
    if (String(url).includes('fetchAvailableModels')) {
      return Response.json({
        models: {
          'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.8, resetTime: reset5h } },
          'o5-mini': { displayName: 'OpenAI o5-mini', quotaInfo: { remainingFraction: 0.6, resetTime: reset5h } },
          'deepseek-r1': { displayName: 'DeepSeek R1', quotaInfo: { remainingFraction: 0.6, resetTime: reset5h } },
        },
      });
    }
    return Response.json({
      groups: [
        { displayName: 'Gemini Models', buckets: [{ bucketId: 'g-5h', window: '5h', remainingFraction: 0.8, resetTime: reset5h }] },
        { displayName: 'Third-Party Models', buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.6, resetTime: reset5h }] },
      ],
    });
  });
  assert.equal(downgraded.quota?.subscription_tier, 'Free');
  const downgradedOverview = manager.getAccountQuotaOverview(downgraded);
  assert.equal(downgradedOverview.subscriptionTier, 'FREE');
  const downgradedIpc = projectAccountForIpcNormalized(downgraded, manager, { includeOverviewFields: true });
  assert.equal(downgradedIpc.subscription_tier, 'FREE');
  assert.equal(downgradedIpc.quota.subscription_tier, 'FREE');
  // o5-mini 与 deepseek-r1 归入共享第三方池 claude，不误拆为 standaloneModels
  assert.deepEqual(downgradedOverview.standaloneModels, []);
  assert.deepEqual(downgradedOverview.projectedQuotaGroups.map(g => g.key), ['gemini', 'claude']);

  // 3) P1-16: 不含 token 字段的 AccountSummary 投影不得误判为 needs_refresh
  const summaryProjected = projectAccountForIpc({
    id: 'summary-only-id',
    email: 'summary@example.test',
    name: 'Summary User',
    created_at: 1700000000,
    last_used: 1700000100,
  });
  assert.equal(summaryProjected.credentialReadiness.state, 'ready');
});

test('1.1.1 终审回归: computeAccountRemaining 含 Argon 别名对齐与云端不完整刷新防套餐误降级', async t => {
  const { manager, acc } = await createTempManager(t);
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const reset5h = new Date(nowMs + 3 * 3600 * 1000).toISOString();
  const resetWeekly = new Date(nowMs + 5 * 86400 * 1000).toISOString();

  acc.quota = {
    subscription_tier: 'PRO',
    source: 'cloud',
    last_updated: nowSec - 120,
    is_forbidden: false,
    model_forwarding_rules: {},
    quota_groups: [
      {
        display_name: 'Gemini Models',
        family: 'gemini',
        buckets: [{ bucket_id: 'g-5h', window: '5h', remaining_fraction: 0.75, remaining_fraction_known: true, reset_time: reset5h, observed_at: nowSec, source: 'cloud' }],
      },
      {
        display_name: 'Gemini 4 Argon',
        family: 'argon',
        buckets: [{ bucket_id: 'a-wk', window: 'weekly', remaining_fraction: 0.35, remaining_fraction_known: true, reset_time: resetWeekly, observed_at: nowSec, source: 'cloud' }],
      },
    ],
    models: [
      { name: 'gemini-3.8-flash', model_id: 'gemini-3.8-flash', family: 'gemini', percentage: 75, percentage_known: true, own_percentage: 75, own_percentage_known: true, own_reset_time: reset5h, own_observed_at: nowSec, reset_time: reset5h },
      { name: 'gemini-4-argon', model_id: 'gemini-4-argon', family: 'argon', is_argon: true, quota_bucket_name: 'Gemini 4 Argon', percentage: 35, percentage_known: true, own_percentage: 35, own_percentage_known: true, own_reset_time: resetWeekly, own_observed_at: nowSec, reset_time: resetWeekly },
    ],
  };
  await manager.saveAccount(acc);

  // 1. P1-12: 含 Argon 的中英文全系别名与 gemini_all 结果严格一致
  assert.equal(computeAccountRemaining(acc, 'Gemini 全系（含 Argon）'), 35);
  assert.equal(computeAccountRemaining(acc, 'All Gemini (incl. Argon)'), 35);

  // 2. P1-9: 云端生产端点失败仅 fallback 端点返回且 loadCodeAssist 临时返回 Starter/Free 时（complete=false），保留原 PRO 不误降级
  const partialRefreshed = await manager.refreshQuota(acc.id, async (url) => {
    const u = String(url);
    if (u.includes('cloudcode-pa.googleapis.com') && !u.includes('daily-cloudcode-pa')) {
      return new Response('Service Unavailable', { status: 503 });
    }
    if (u.includes('loadCodeAssist')) {
      return Response.json({ currentTier: { id: 'starter', name: 'Starter' } });
    }
    if (u.includes('fetchAvailableModels')) {
      return Response.json({
        models: {
          'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.70, resetTime: reset5h } },
        },
      });
    }
    return Response.json({
      groups: [
        { displayName: 'Gemini Models', buckets: [{ bucketId: 'g-5h', window: '5h', remainingFraction: 0.70, resetTime: reset5h }] },
      ],
    });
  });
  assert.equal(partialRefreshed.quota?.refresh_state?.complete, false);
  assert.equal(partialRefreshed.quota?.subscription_tier, 'PRO', '不完整云端回退刷新不得把已存 PRO 误降级为 FREE');
});





