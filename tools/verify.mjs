// AntigravityBox 打包前校验:构建产物自洽 + 注入包契约完整。
// 任何一项失败都应中止 NSIS 打包,避免发出版本缺词典/缺引擎。
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const required = [
  'electron/main.js',
  'electron/preload.cjs',
  'core/engine.js',
  'core/controller.js',
  'core/dictionary.js',
  'dict/base.json',
  'renderer/index.html',
  'renderer/app.js',
  'renderer/icon.png',
  'runtime/hud-manager.js',
];

let failed = 0;
for (const rel of required) {
  try {
    await access(join(dist, rel));
    console.log(`ok      ${rel}`);
  } catch {
    console.error(`missing ${rel}`);
    failed++;
  }
}

// engine.js 必须同时包含引擎契约与 HUD 运行时(缺一即说明 copy-runtime 未执行完整)。
const engine = await readFile(join(dist, 'core', 'engine.js'), 'utf8');
const checks = [
  ['__GRAVITYBOX_ENGINE_V1__', engine.includes('__GRAVITYBOX_ENGINE_V1__')],
  ['__GRAVITYBOX_BOOT__', engine.includes('__GRAVITYBOX_BOOT__')],
  ['HUD 运行时', engine.includes('bootstrapGravityBoxHud')],
];
for (const [name, ok] of checks) {
  if (ok) console.log(`ok      engine.js ${name}`);
  else { console.error(`bad     engine.js 缺少 ${name}`); failed++; }
}

if (failed > 0) {
  console.error(`\nverify 失败:${failed} 项缺失 — 请先运行 npm run build`);
  process.exit(1);
}
console.log('\nverify 通过:打包产物完整');
