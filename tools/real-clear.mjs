// AntigravityBox — 真实维护清理(用户触发型,非自动验收项)。
// 流程:温和退出 Antigravity → 真实 scan → clear(默认勾选项)→ 快照与复扫校验。
// 安全边界:绝不强杀 Antigravity;清理被核心层拒绝即中止;所有移动进快照,可经 UI/restore 恢复。
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { Backend } from '../dist/electron/backend.js';
import { requestGracefulQuit, waitForExit } from '../dist/windows/lifecycle.js';
import { isApplicationRunning } from '../dist/core/discovery.js';
import { applicationTarget } from '../dist/core/application-target.js';

const target = applicationTarget();
const backend = new Backend();

// 1. 温和退出(运行中才需要;应用弹窗挽留未保存工作时 waitForExit 会超时 → 拒绝继续)
if (await isApplicationRunning(target.appPath)) {
  console.log('Antigravity 运行中 → 发送温和退出请求(绝不强杀)…');
  const q = await requestGracefulQuit(target.appPath);
  console.log(`退出请求已送达 ${q.requested} 个窗口`);
  if (!(await waitForExit(target.appPath, 30_000))) {
    console.log('RESULT: quit-refused(应用未在 30s 内自行退出 — 存在未保存工作/活跃会话;未做任何改动)');
    process.exit(2);
  }
  await new Promise(r => setTimeout(r, 300)); // 与 safeRelaunch 相同的 settle 窗口
}
console.log('Antigravity 已退出 ✓');

// 2. 真实扫描 → 展示默认勾选项(与 UI 默认一致:safe 类 + clearable + 有字节)
const scan = await backend.maintenanceScan({});
const defaults = scan.entries.filter(e => e.defaultSelected !== false && e.clearable !== false && e.bytes > 0);
console.log(`回收仓: ${scan.trashDir}${scan.usingFallbackTrash ? '(回退本地)' : ''}`);
for (const e of defaults) console.log(`  · ${e.name} [${e.category}] ${e.bytes} B / ${e.fileCount} 文件`);
const totalBytes = defaults.reduce((n, e) => n + e.bytes, 0);
console.log(`默认清理: ${defaults.length} 项 / ${totalBytes} B`);

// 3. 真实清理(120s token 窗口内;Antigravity 已退出,running 闸通过)
const result = await backend.maintenanceClear(scan.token, defaults.map(e => e.name));
console.log('清理结果:', JSON.stringify({
  moved: result.moved,
  movedPaths: result.movedPaths,
  clearedBytes: result.clearedBytes,
  clearedFiles: result.clearedFiles,
  snapshotId: result.snapshotId,
  skipped: result.skipped,
  usingFallbackTrash: result.usingFallbackTrash,
}, null, 2));

// 4. 校验:恢复清单存在 + 快照可被 restore 定位
await access(join(result.restorePath, '恢复清单.json'));
console.log('恢复清单.json ✓');
const hist = await backend.maintenance.history();
const snap = (hist ?? []).find(s => s.id === result.snapshotId);
console.log('快照登记:', snap ? `id=${snap.id} bytes=${snap.totalBytes} files=${snap.fileCount} restorable=${snap.restorable}` : '未找到(异常)');

// 5. 复扫对比
const rescan = await backend.maintenanceScan({});
const after = rescan.entries.reduce((n, e) => n + (e.bytes ?? 0), 0);
console.log(`复扫 clearable 总量: ${after} B(清理前 ${scan.totalBytes} B,应显著下降)`);

const ok = snap?.restorable === true && after < scan.totalBytes;
console.log(ok ? 'RESULT: real-clear-ok ✓' : 'RESULT: real-check-failed ✗');
process.exit(ok ? 0 : 1);
