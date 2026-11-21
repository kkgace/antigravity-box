import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function buildPricingFeed(catalog) {
  const prices = {};
  const models = {};
  for (const key of catalog.feedModels ?? []) {
    const price = catalog.prices[key];
    if (!price) throw Error('公开价格表引用了不存在的模型：' + key);
    prices[key] = Array.isArray(price) ? price : price.intervals ?? [{ model: price.model, validFrom: price.provenance?.validFrom ?? null, validUntil: price.provenance?.validUntil ?? null,
      input: price.input, output: price.output, cached: price.cached, ...(price.cacheWrite !== undefined ? { cacheWrite: price.cacheWrite } : {}), ...(Array.isArray(price.contextTiers) ? { contextTiers: price.contextTiers } : {}), provenance: price.provenance }];
    const displayName = catalog.names?.[key];
    const capacityTokens = catalog.capacities?.[key];
    if ((typeof displayName === 'string' && displayName) || (Number.isSafeInteger(capacityTokens) && capacityTokens > 0)) {
      models[key] = {
        ...(typeof displayName === 'string' && displayName ? { displayName } : {}),
        ...(Number.isSafeInteger(capacityTokens) && capacityTokens > 0 ? { capacityTokens } : {}),
      };
    }
  }
  const hasActiveModels = Array.isArray(catalog.activeModels) && catalog.activeModels.length > 0;
  const feedModelSet = new Set(Array.isArray(catalog.feedModels) ? catalog.feedModels : []);
  if (hasActiveModels) {
    for (const key of catalog.activeModels) {
      if (!Object.hasOwn(catalog.prices ?? {}, key)) throw Error('活跃模型列表引用了不存在的模型：' + key);
      if (feedModelSet.size > 0 && !feedModelSet.has(key)) {
        throw Error('活跃模型列表引用了未包含在 feedModels 中的模型：' + key);
      }
    }
  }
  const hasAliases = Boolean(catalog.aliases && typeof catalog.aliases === 'object' && Object.keys(catalog.aliases).length > 0);
  const hasModels = Object.keys(models).length > 0;
  return {
    version: catalog.pricingVersion,
    schema: 1,
    updatedAt: catalog.pricingUpdatedAt,
    source: 'https://raw.githubusercontent.com/Enzoo404/gravitybox/main/assets/pricing-feed.json',
    ...(hasAliases ? { aliases: catalog.aliases } : {}),
    ...(hasActiveModels ? { activeModels: catalog.activeModels } : {}),
    ...(hasModels ? { models } : {}),
    prices,
  };
}
async function main() {
  const catalog = JSON.parse(await readFile(new URL('../assets/model-catalog.json', import.meta.url), 'utf8'));
  const file = new URL('../assets/pricing-feed.json', import.meta.url);
  const text = JSON.stringify(buildPricingFeed(catalog), null, 2) + '\n';
  if (process.argv.includes('--write')) await writeFile(file, text);
  else if (await readFile(file, 'utf8') !== text) throw Error('价格资产不同步，请审阅模型目录后显式运行 node tools/sync-pricing-feed.mjs --write');
  console.log('模型目录与公开价格表一致');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
