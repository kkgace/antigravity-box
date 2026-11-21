// AntigravityBox 一键验收:全量测试聚合。
// 顺序:构建 → 打包产物校验 → 单元测试 → 真实数据 e2e → HUD 引擎 e2e → M3 只读 e2e。
// 任何一环失败即中止并保留失败详情;全部通过输出验收汇总表。
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

const stages = [
  { name: '构建 (tsc + staging + engine.js + ICO)', cmd: [node, join(root, 'tools', 'build.mjs')] },
  { name: '打包产物完整性', cmd: [node, join(root, 'tools', 'verify.mjs')] },
  { name: '单元测试 (116 项,移植自上游)', cmd: [node, join(root, 'tools', 'run-tests.mjs')] },
  { name: 'e2e 数据链 (凭据/配额/用量/发现,真实环境)', cmd: [node, join(root, 'tools', 'e2e-check.mjs')] },
  { name: 'e2e HUD 引擎 (注入包/词典/状态机/语言链)', cmd: [node, join(root, 'tools', 'e2e-hud.mjs')] },
  { name: 'e2e M3 只读 (切换就绪/恢复协议/维护扫描与清理链路/账本)', cmd: [node, join(root, 'tools', 'e2e-m3.mjs')] },
];

const started = Date.now();
const outcomes = [];
console.log('══════════════════════════════════════════════');
console.log('  AntigravityBox 全量验收');
console.log('══════════════════════════════════════════════\n');

for (const stage of stages) {
  const t0 = Date.now();
  console.log(`\n▶ ${stage.name}`);
  const result = spawnSync(stage.cmd[0], stage.cmd.slice(1), { cwd: root, stdio: 'inherit' });
  const ok = result.status === 0;
  outcomes.push({ name: stage.name, ok, ms: Date.now() - t0 });
  if (!ok) {
    console.error(`\n✖ 验收在「${stage.name}」中止(退出码 ${result.status ?? '?'})`);
    break;
  }
}

console.log('\n══════════════════════════════════════════════');
console.log('  验收汇总');
console.log('══════════════════════════════════════════════');
for (const o of outcomes) {
  console.log(`${o.ok ? '✔' : '✖'} ${o.name}  ${(o.ms / 1000).toFixed(1)}s`);
}
console.log('──────────────────────────────────────────────');
const passed = outcomes.filter(o => o.ok).length;
console.log(`${passed}/${stages.length} 阶段通过,总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (passed === stages.length) {
  console.log('验收结论:全部通过 ✅');
  process.exit(0);
} else {
  console.log('验收结论:存在失败 ❌');
  process.exit(1);
}
