// Ported from Enzoo404/gravitybox (MIT License) v1.1.2 — https://github.com/Enzoo404/gravitybox
// Windows adaptation: AntigravityBox project.
import { normalizeModelId } from '../model-identity.js';
import { getEffectiveModelPriceAlias, getRemoteModelSpec, MODEL_CAPACITIES, MODEL_NAMES } from '../model-catalog.js';
import { resolveDatabaseModelFullName } from '../usage-types.js';
import { bt } from '../i18n.js';
/**
 * Antigravity 模型有效上下文窗口阈值映射目录
 * 严格对齐 Antigravity 官方运行时与 assets/model-catalog.json 标准上下文阈值 (<=200K / 256K / 128K)
 * 彻底剔除从第三方插件照搬的 1M / 2M 虚假容量
 */

export interface ModelCapacitySpec {
  modelId: string;
  displayName: string;
  capacityTokens: number;
  capacityCompact: string;
  isFallback: boolean;
}

/**
 * Antigravity 标准上下文压缩阈值 (对齐 assets/model-catalog.json <=200K 标准上下文基准)
 */
export const DEFAULT_CONTEXT_CAPACITY_TOKENS = 200_000;

interface ModelFamilyRule {
  pattern: RegExp;
  capacityTokens: number;
  capacityCompact: string;
  defaultDisplayName: string;
}

/**
 * 模型族参考容量（只有请求明确返回的容量才是实测值）
 * 缺少明确容量时才使用这些参考值；不能据此断言宿主实际窗口或压缩阈值，
 * 绝不展示虚构的 1M / 2M 容量。
 */
const MODEL_CAPACITY_RULES: readonly ModelFamilyRule[] = [
  {
    pattern: /^gemini-(?:1\.5|2\.0|2\.5|3(?:\.\d+)?)-pro|^gemini-pro/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Gemini Pro',
  },
  {
    pattern: /^gemini-(?:1\.5|2\.0|2\.5|3(?:\.\d+)?)-flash/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Gemini Flash',
  },
  {
    pattern: /^gemini-4-argon/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Gemini 4 Argon',
  },
  {
    pattern: /^gemini-4-carbon/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Gemini 4 Carbon',
  },
  {
    pattern: /^gemini-[4-9](?:\.\d+)?-[a-z0-9]+/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Gemini',
  },
  {
    pattern: /^claude-(?:3|4|5)|^claude-(?:sonnet|opus|haiku)/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Claude',
  },
  {
    pattern: /^gpt-4o|^gpt-4\.1|^gpt-5|^o1|^o3|^o4/i,
    capacityTokens: 128_000,
    capacityCompact: '128K',
    defaultDisplayName: 'GPT-4o',
  },
  {
    pattern: /^gpt-oss/i,
    capacityTokens: 128_000,
    capacityCompact: '128K',
    defaultDisplayName: 'GPT-OSS',
  },
];

const INTERNAL_DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  'gemini-4-argon-trial': 'Gemini 4 Argon Trial',
  'gemini-4-carbon-trial': 'Gemini 4 Carbon Trial',
  'gemini-3.8-flash-control': 'Gemini 3.8 Flash',
  'gemini-3.8-flash-n': 'Gemini 3.8 Flash',
  'gemini-3.8-flash-tiered': 'Gemini 3.8 Flash',
  'gemini-3.8-flash-exp-a': 'Gemini 3.8 Flash',
  'gemini-3.7-flash-tiered': 'Gemini 3.7 Flash',
  'gemini-3.7-flash-safety-le': 'Gemini 3.7 Flash',
  'gemini-3.6-flash-tiered': 'Gemini 3.6 Flash',
  'gemini-3.6-flash-exp-a': 'Gemini 3.6 Flash',
  'gemini-3-flash': 'Gemini 3 Flash',
  'gemini-3-flash-a': 'Gemini 3 Flash',
  'gemini-pro-default': 'Gemini Pro',
};

function formatCompactCapacity(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : Number(m.toFixed(1))}M`;
  }
  const k = Math.round(tokens / 1_000);
  return `${k}K`;
}

function autoFormatDynamicModelName(normalizedId: string): string | null {
  const geminiMatch = normalizedId.match(/^gemini-([4-9](?:\.\d+)?)-([a-z][a-z0-9]*?)(?:-(trial|preview|exp))?$/i);
  if (geminiMatch) {
    const ver = geminiMatch[1]!;
    const code = geminiMatch[2]!.charAt(0).toUpperCase() + geminiMatch[2]!.slice(1).toLowerCase();
    const suffix = geminiMatch[3]
      ? ` ${geminiMatch[3].charAt(0).toUpperCase() + geminiMatch[3].slice(1).toLowerCase()}`
      : '';
    return `Gemini ${ver} ${code}${suffix}`;
  }
  const claudeMatch = normalizedId.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/i);
  if (claudeMatch) {
    const tier = claudeMatch[1]!.charAt(0).toUpperCase() + claudeMatch[1]!.slice(1).toLowerCase();
    return `Claude ${tier} ${claudeMatch[2]}.${claudeMatch[3]}`;
  }
  return null;
}

/**
 * 归一化前端 DOM 探针或 SQLite gen_metadata 传入的模型字符串，解析对应的 Antigravity 有效上下文阈值与展示名称
 */
export function resolveModelCapacity(rawModelInput?: string | null, depth = 0): ModelCapacitySpec {
  const raw = typeof rawModelInput === 'string' ? rawModelInput.trim() : '';
  if (!raw) {
    return {
      modelId: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      capacityTokens: DEFAULT_CONTEXT_CAPACITY_TOKENS,
      capacityCompact: '200K',
      isFallback: false,
    };
  }

  // 清理 API 前缀、前端按钮可能附带的加号、下拉箭头及思考档位后缀（如 "models/gemini-3.8-flash", "+ Gemini 3.8 Flash High ^"）
  const withoutApiPrefix = raw.replace(/^models\//i, '').trim();
  const cleanedRaw = (withoutApiPrefix || raw)
    .replace(/^[+\s·•]+|[⌃⌄^\s]+$/g, '')
    .replace(/[（(]\s*(?:Extra\s+High|Extra\s+Low|XHigh|High|Medium|Low|Max|Thinking|高|中|低|思考)\s*[）)]/gi, '')
    .replace(/\s+(?:Extra\s+High|Extra\s+Low|XHigh|High|Medium|Low|Max|Thinking)\b.*$/i, '')
    .trim();

  if (depth < 2) {
    const directDynamicAlias = getEffectiveModelPriceAlias(cleanedRaw);
    if (directDynamicAlias && directDynamicAlias.toLowerCase() !== cleanedRaw.toLowerCase()) {
      return resolveModelCapacity(directDynamicAlias, depth + 1);
    }
    if (/\borchestrator\b|^gemini-flash-worker(?:-agy)?$|^MODEL_PLACEHOLDER_M\d+$/i.test(cleanedRaw)) {
      const resolvedAlias = resolveDatabaseModelFullName(cleanedRaw, cleanedRaw);
      if (resolvedAlias && resolvedAlias !== '未知模型' && resolvedAlias !== 'Unknown Model' && resolvedAlias !== bt('usage.unknown_model') && resolvedAlias !== cleanedRaw) {
        return resolveModelCapacity(resolvedAlias, depth + 1);
      }
    }
  }

  let normalizedId = (cleanedRaw || withoutApiPrefix || raw)
    .toLowerCase()
    .replace(/^models-/, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');

  normalizedId = normalizeModelId(normalizedId)
    .replace(/(?:-(?:extra-high|extra-low|xhigh|high|medium|low|max|thinking|latest))+$/, '');

  if (depth < 2) {
    const normalizedAlias = getEffectiveModelPriceAlias(normalizedId);
    if (normalizedAlias && normalizedAlias.toLowerCase() !== normalizedId) {
      return resolveModelCapacity(normalizedAlias, depth + 1);
    }
  }

  const remoteSpec = getRemoteModelSpec(normalizedId);
  const bundledCapacity =
    Object.hasOwn(MODEL_CAPACITIES, normalizedId) &&
    typeof MODEL_CAPACITIES[normalizedId] === 'number' &&
    MODEL_CAPACITIES[normalizedId]! > 0
      ? MODEL_CAPACITIES[normalizedId]!
      : undefined;
  const displayName =
    remoteSpec?.displayName ||
    INTERNAL_DISPLAY_NAME_OVERRIDES[normalizedId] ||
    (Object.hasOwn(MODEL_NAMES, normalizedId) ? MODEL_NAMES[normalizedId] : undefined) ||
    autoFormatDynamicModelName(normalizedId) ||
    cleanedRaw ||
    raw;

  const explicitCap = remoteSpec?.capacityTokens ?? bundledCapacity;
  if (explicitCap) {
    return {
      modelId: normalizedId,
      displayName,
      capacityTokens: explicitCap,
      capacityCompact: formatCompactCapacity(explicitCap),
      isFallback: false,
    };
  }

  for (const rule of MODEL_CAPACITY_RULES) {
    if (rule.pattern.test(normalizedId)) {
      return {
        modelId: normalizedId,
        displayName,
        capacityTokens: rule.capacityTokens,
        capacityCompact: rule.capacityCompact,
        isFallback: false,
      };
    }
  }

  if (remoteSpec?.displayName) {
    return {
      modelId: normalizedId,
      displayName,
      capacityTokens: DEFAULT_CONTEXT_CAPACITY_TOKENS,
      capacityCompact: '200K',
      isFallback: false,
    };
  }

  return {
    modelId: normalizedId || 'unknown-model',
    displayName: cleanedRaw || raw || bt('usage.unknown_model'),
    capacityTokens: DEFAULT_CONTEXT_CAPACITY_TOKENS,
    capacityCompact: '~200K',
    isFallback: true,
  };
}
