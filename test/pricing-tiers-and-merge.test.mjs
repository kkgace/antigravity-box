import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_API_PRICES,
  mergePricingEntries,
  resolvePricingForTimestamp,
  priceStatus,
  validateRawPrices,
  resolveContextTierPricing,
  calculateEstimatedUsd,
  matchPricingKeys,
} from '../dist/core/pricing.js';

test('P0-12: mergePricingEntries 与 resolvePricingForTimestamp 阻断基础条款 validUntil 污染开放区间', async () => {
  const feed = JSON.parse(await readFile(new URL('../assets/pricing-feed.json', import.meta.url), 'utf8'));
  const merged = structuredClone(DEFAULT_API_PRICES);
  const warnings = [];
  mergePricingEntries(merged, feed.prices, 'warn:', warnings);
  assert.deepEqual(warnings, []);

  const june2027Ms = Date.parse('2027-06-01T00:00:00Z');
  const june2027Sec = Math.floor(june2027Ms / 1000);

  for (const model of ['gemini-3.8-flash', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-4-neon']) {
    const resolved = resolvePricingForTimestamp(merged[model], june2027Sec, model);
    assert.ok(resolved, `${model} 在 2027-06-01 应解析出有效区间`);
    assert.equal(resolved.provenance?.validUntil, undefined, `${model} 开放区间不得继承过期 validUntil`);
    assert.equal(priceStatus(merged[model], june2027Ms), 'confirmed', `${model} 在 2027-06-01 应为 confirmed 而非 expired`);
  }

  // 验证显式基础 validFrom/validUntil 不会泄露给无界或改写边界的子区间
  const customBase = {
    'tiered-promo': {
      model: 'tiered-promo',
      input: 1,
      output: 5,
      cached: 0.1,
      provenance: {
        sourceUrl: 'https://example.invalid/pricing',
        validFrom: '2026-10-01T00:00:00Z',
        validUntil: '2026-12-31T23:59:59Z',
        verification: 'confirmed',
      },
    },
  };
  mergePricingEntries(
    customBase,
    {
      'tiered-promo': {
        model: 'tiered-promo',
        input: 2,
        output: 10,
        cached: 0.2,
        intervals: [
          {
            validFrom: null,
            validUntil: '2026-12-31T23:59:59Z',
            input: 1,
            output: 5,
            cached: 0.1,
          },
          {
            validFrom: '2027-01-01T00:00:00Z',
            validUntil: null,
            input: 2,
            output: 10,
            cached: 0.2,
            provenance: { verification: 'confirmed' },
          },
        ],
      },
    },
    'warn:',
    warnings
  );
  assert.deepEqual(warnings, []);

  // 2026-09 早于原 validFrom 的无起点区间不应被 baseProv.validFrom 拦截
  const sep2026 = resolvePricingForTimestamp(customBase['tiered-promo'], Math.floor(Date.parse('2026-09-15T00:00:00Z') / 1000));
  assert.ok(sep2026);
  assert.equal(sep2026.input, 1);
  assert.equal(sep2026.provenance?.validFrom, undefined);
  assert.equal(sep2026.provenance?.validUntil, '2026-12-31T23:59:59Z');

  // 2027-06 开放区间不应继承 baseProv.validUntil
  const resolved2027 = resolvePricingForTimestamp(customBase['tiered-promo'], june2027Sec);
  assert.ok(resolved2027);
  assert.equal(resolved2027.input, 2);
  assert.equal(resolved2027.provenance?.validUntil, undefined);
  assert.equal(resolved2027.provenance?.validFrom, '2027-01-01T00:00:00Z');
  assert.equal(priceStatus(resolved2027, june2027Ms), 'confirmed');
});

test('P1-10: contextTiers 校验、多阶梯匹配与按单步总上下文阈值计费', () => {
  const valid = validateRawPrices({
    'long-ctx-model': {
      model: 'long-ctx-model',
      input: 1.0,
      output: 4.0,
      cached: 0.1,
      cacheWrite: 1.25,
      contextTiers: [
        { thresholdTokens: 200_000, input: 2.0, output: 8.0, cached: 0.2, cacheWrite: 2.5 },
        { thresholdTokens: 500_000, input: 4.0, output: 16.0, cached: 0.4, cacheWrite: 5.0 },
      ],
    },
  });

  const pricing = valid['long-ctx-model'];
  assert.equal(resolveContextTierPricing(pricing, 200_000).input, 1.0);
  assert.equal(resolveContextTierPricing(pricing, 200_001).input, 2.0);
  assert.equal(resolveContextTierPricing(pricing, 500_000).input, 2.0);
  assert.equal(resolveContextTierPricing(pricing, 500_001).input, 4.0);

  const inclusivePricing = {
    model: 'inc-model',
    input: 1.0,
    output: 4.0,
    cached: 0.1,
    contextTiers: [{ thresholdTokens: 200_000, inclusive: true, input: 2.0, output: 8.0, cached: 0.2 }],
  };
  assert.equal(resolveContextTierPricing(inclusivePricing, 199_999).input, 1.0);
  assert.equal(resolveContextTierPricing(inclusivePricing, 200_000).input, 2.0);

  // 单步总上下文 = input + cached + cacheWrite：100_000 + 80_000 + 20_000 = 200_000 -> 基础阶梯
  const baseStepUsd = calculateEstimatedUsd(100_000, 100_000, 80_000, pricing, 20_000);
  const expectedBase = (100_000 * 1.0 + 100_000 * 4.0 + 80_000 * 0.1 + 20_000 * 1.25) / 1_000_000;
  assert.ok(Math.abs(baseStepUsd - expectedBase) < 1e-12);

  // 即使 rawInputTokens (100_001) < 200k，加上 cached + cacheWrite = 200_001 > 200k -> 切换到高阶梯费率
  const highStepUsd = calculateEstimatedUsd(100_001, 100_000, 80_000, pricing, 20_000);
  const expectedHigh = (100_001 * 2.0 + 100_000 * 8.0 + 80_000 * 0.2 + 20_000 * 2.5) / 1_000_000;
  assert.ok(Math.abs(highStepUsd - expectedHigh) < 1e-12);

  // 非法 contextTiers 必须被 validateRawPrices 拒绝
  assert.throws(() => validateRawPrices({
    bad1: { model: 'bad1', input: 1, output: 2, cached: 0.1, contextTiers: [{ thresholdTokens: 0, input: 2, output: 4, cached: 0.2 }] },
  }));
  assert.throws(() => validateRawPrices({
    bad2: { model: 'bad2', input: 1, output: 2, cached: 0.1, contextTiers: [{ thresholdTokens: 200_000, input: -1, output: 4, cached: 0.2 }] },
  }));
  assert.throws(() => validateRawPrices({
    bad3: { model: 'bad3', input: 1, output: 2, cached: 0.1, contextTiers: [{ thresholdTokens: 200_000, input: 2, output: 4, cached: 0.2, cacheWrite: 999 }] },
  }));
});

test('P1-14: matchPricingKeys 识别 xhigh / extra-high 等思考后缀与远端动态候选键', async () => {
  const { lookupPricingEntry, localizePricingProvenance } = await import('../dist/core/pricing.js');
  const { buildPricingFeed } = await import('../tools/sync-pricing-feed.mjs');
  assert.equal(matchPricingKeys('claude-opus-5-5-xhigh'), 'claude-opus-5-5');
  assert.equal(matchPricingKeys('gemini-3.8-flash-extra-high'), 'gemini-3.8-flash');
  assert.equal(matchPricingKeys('gemini-4-neon-high', ['gemini-4-neon']), 'gemini-4-neon');
  assert.equal(matchPricingKeys('gemini-5-xenon-high', ['gemini-5-xenon']), 'gemini-5-xenon');
  assert.equal(matchPricingKeys('claude-sonnet-6-0-thinking-20270301', ['claude-sonnet-6-0']), 'claude-sonnet-6-0');

  const customTable = {
    'gemini-4-neon': { model: 'gemini-4-neon', input: 2.5, output: 12.5, cached: 0.25 },
  };
  const lookedUp = lookupPricingEntry(customTable, 'gemini-4-neon-thinking');
  assert.equal(lookedUp?.key, 'gemini-4-neon');

  const exportedFeed = buildPricingFeed({
    pricingVersion: '2026-11-15',
    pricingUpdatedAt: '2026-11-15T00:00:00Z',
    feedModels: ['tiered-feed-model'],
    prices: {
      'tiered-feed-model': {
        model: 'tiered-feed-model',
        input: 1.25,
        output: 5.0,
        cached: 0.125,
        contextTiers: [{ thresholdTokens: 200_000, input: 2.5, output: 10.0, cached: 0.25 }],
        provenance: {
          sourceUrl: 'https://cloud.google.com/model-garden/pricing?hl=en',
          platform: 'Google Cloud 标准 Global API',
          conditions: '标准全量定价（2027-01-01生效）',
          verification: 'confirmed',
        },
      },
    },
  });
  assert.equal(exportedFeed.prices['tiered-feed-model'][0].contextTiers?.length, 1);
  assert.equal(exportedFeed.prices['tiered-feed-model'][0].contextTiers[0].thresholdTokens, 200_000);

  const enProv = localizePricingProvenance(exportedFeed.prices['tiered-feed-model'][0].provenance, 'en');
  assert.equal(enProv?.platform, 'Google Cloud Standard Global API');
  assert.equal(/[\u4e00-\u9fff]/.test(enProv?.conditions ?? ''), false);

  const feedWithActive = buildPricingFeed({
    pricingVersion: '2026-11-15',
    pricingUpdatedAt: '2026-11-15T00:00:00Z',
    feedModels: ['tiered-feed-model', 'retired-feed-model'],
    activeModels: ['tiered-feed-model'],
    prices: {
      'tiered-feed-model': { model: 'tiered-feed-model', input: 1, output: 2, cached: 0.1 },
      'retired-feed-model': { model: 'retired-feed-model', input: 3, output: 6, cached: 0.3 },
    },
  });
  assert.deepEqual(feedWithActive.activeModels, ['tiered-feed-model']);
  assert.throws(() => buildPricingFeed({
    pricingVersion: '2026-11-15',
    pricingUpdatedAt: '2026-11-15T00:00:00Z',
    feedModels: ['tiered-feed-model'],
    activeModels: ['missing-active-model'],
    prices: {
      'tiered-feed-model': { model: 'tiered-feed-model', input: 1, output: 2, cached: 0.1 },
    },
  }));

  const { canonicalActivePricingKeys } = await import('../dist/core/pricing.js');
  const { ACTIVE_MODEL_KEYS } = await import('../dist/core/model-catalog.js');
  const mappedOrch = canonicalActivePricingKeys([
    'gemini-pro-orchestrator',
    'tab_flash_lite_preview',
    'gemini-3.8-flash-exp-a',
  ]);
  assert.deepEqual([...mappedOrch], ['gemini-4-argon']);
  assert.deepEqual([...canonicalActivePricingKeys(['chat_20706', 'gemini-4-argon-trial'])], [...ACTIVE_MODEL_KEYS]);
});
