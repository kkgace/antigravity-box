// AntigravityBox — 生成 dist/core/engine.js(CDP 注入包)。
// Ported from Enzoo404/gravitybox tools/copy-runtime.mjs (MIT License).
// 由 runtime/*.js 合并出可在 CDP Isolated World 经典脚本上下文直接执行的 IIFE,
// 并校验 runtime/hud-i18n.js 与 assets/i18n/*.json#hud 双源一致。
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Script, runInNewContext } from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 将支持 Node.js ESM import 的 runtime/hud-*.js 转换为经典脚本可执行片段 */
function stripEsmForClassicRuntime(code) {
  return code
    .replace(/^\s*import\s+[^;]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+(?=(?:async\s+function|const|let|var|function|class)\s+)/gm, '')
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '');
}

async function loadAndSyncHudI18n(rawHudI18nSource) {
  const [zhJsonRaw, enJsonRaw] = await Promise.all([
    readFile(join(root, 'assets', 'i18n', 'zh-Hans.json'), 'utf8'),
    readFile(join(root, 'assets', 'i18n', 'en.json'), 'utf8'),
  ]);
  const jsonHud = {
    'zh-Hans': JSON.parse(zhJsonRaw)?.hud ?? {},
    en: JSON.parse(enJsonRaw)?.hud ?? {},
  };
  const sandbox = {};
  const evalCode = stripEsmForClassicRuntime(rawHudI18nSource).replace(
    /\bconst\s+(HUD_FALLBACK_LOCALE|HUD_I18N)\b/g,
    'var $1'
  );
  runInNewContext(evalCode, sandbox, { filename: 'hud-i18n-sync-check.js' });
  const runtimeHud = sandbox.HUD_I18N ?? {};
  for (const locale of ['zh-Hans', 'en']) {
    const expected = jsonHud[locale];
    const actual = runtimeHud[locale] ?? {};
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    if (
      expectedKeys.length === 0 ||
      expectedKeys.length !== actualKeys.length ||
      expectedKeys.some((key, index) => key !== actualKeys[index] || expected[key] !== actual[key])
    ) {
      throw new Error(
        `runtime/hud-i18n.js (${locale}) 与 assets/i18n/${locale}.json#hud 不一致,请先同步双源 HUD 词条`
      );
    }
  }
  const hudLiteral = JSON.stringify(jsonHud, null, 2);
  const replaced = rawHudI18nSource.replace(
    /export\s+const\s+HUD_I18N\s*=\s*\{[\s\S]*?\n\};/,
    `export const HUD_I18N = ${hudLiteral};`
  );
  if (!replaced.includes(hudLiteral)) {
    throw new Error('未能在 runtime/hud-i18n.js 中定位 HUD_I18N 注入点');
  }
  return replaced;
}

export async function copyRuntime(distCoreDir = join(root, 'dist', 'core')) {
  const baseSources = await Promise.all(
    ['engine.js', 'deep-scan.js'].map(name => readFile(join(root, 'runtime', name), 'utf8'))
  );
  const hudSources = await Promise.all(
    ['hud-i18n.js', 'hud-styles.js', 'hud-popover.js', 'hud-instance.js', 'hud-manager.js'].map(async name => {
      const raw = await readFile(join(root, 'runtime', name), 'utf8');
      const synced = name === 'hud-i18n.js' ? await loadAndSyncHudI18n(raw) : raw;
      return stripEsmForClassicRuntime(synced);
    })
  );
  const formatSource = stripEsmForClassicRuntime(
    await readFile(join(distCoreDir, 'metric-format.js'), 'utf8')
  );
  // AntigravityBox: 命名空间标记保留 gravitybox 语义(引擎内 __GRAVITYBOX_* 契约未改名)。
  const hudBundle = `(function bootstrapGravityBoxHud() {\n'use strict';\n${formatSource}\n${hudSources.join('\n')}\n})();`;
  const mergedSource = [...baseSources, hudBundle].join('\n');
  // 语法闸门:合并产物必须能作为经典脚本解析。
  new Script(mergedSource, { filename: 'AntigravityBox-runtime.js' });
  await writeFile(join(distCoreDir, 'engine.js'), mergedSource, 'utf8');
}
