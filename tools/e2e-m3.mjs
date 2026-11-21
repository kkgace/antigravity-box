// AntigravityBox M3 E2E — 切换就绪与存储治理(真实环境,只读)。
// 验证切换前置检查、恢复协议状态、真实 profile 维护扫描与用量账本,全部为无变更操作。
// 真实账号切换(写凭据)与实际清理(移动文件)仅在用户明确触发时执行。
import { Backend } from '../dist/electron/backend.js';

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const backend = new Backend();

// 1. 切换前置检查(真实运行态)
{
  try {
    const { isApplicationRunning } = await import('../dist/core/discovery.js');
    const running = await isApplicationRunning(backend.target.appPath);
    record('switch.preflight', typeof running === 'boolean', `appRunning=${running} switchSupported=${backend.target.supportsAccountSwitch}`);
  } catch (error) {
    record('switch.preflight', false, error.message);
  }
}

// 2. 恢复协议状态(journal/rollback 文件存在性,只读)
{
  try {
    const info = await backend.switchService.recoveryInfo();
    record('switch.recovery_info', info && typeof info === 'object', `pending=${info.pending ?? false} status=${info.status ?? 'clean'}`);
  } catch (error) {
    record('switch.recovery_info', false, error.message);
  }
}

// 3. 自动切换配置(读)
{
  try {
    const config = await backend.accountsManager.getAutoSwitchConfig();
    record('autoswitch.get', config && typeof config === 'object', `enabled=${config.enabled ?? false} threshold=${config.threshold ?? '-'}`);
  } catch (error) {
    record('autoswitch.get', false, error.message);
  }
}

// 4. 真实 profile 维护扫描(READ-ONLY:scan 不移动任何文件)
{
  try {
    const t0 = Date.now();
    const scan = await backend.maintenanceScan({});
    const ms = Date.now() - t0;
    const entries = scan.entries ?? [];
    const totalBytes = entries.reduce((n, e) => n + (e.bytes ?? 0), 0);
    record("maintenance.scan", Array.isArray(entries), `entries=${entries.length} clearableBytes=${totalBytes} usingFallbackTrash=${scan.usingFallbackTrash ?? false} in ${ms}ms`);
    const top = entries.filter(e => e.bytes > 0).sort((a, b) => b.bytes - a.bytes).slice(0, 4);
    for (const e of top) console.log(`      · ${e.name}: ${e.bytes} B`);
  } catch (error) {
    record('maintenance.scan', false, error.message);
  }
}

// 5. 用量账本审查(只读)
{
  try {
    const ledger = await backend.usageManager.ledgerReview();
    const events = Array.isArray(ledger?.events) ? ledger.events.length : Object.keys(ledger ?? {}).length;
    record('usage.ledger_review', ledger != null, `shape=${events} 项`);
  } catch (error) {
    record('usage.ledger_review', false, error.message);
  }
}

// 6. 维护清理链路接线验证:无效 token 必须在触碰任何文件前被拒(token 校验先于 running/移动)。
{
  try {
    let threw = null;
    try { await backend.maintenanceClear('agbox-invalid-token', undefined); }
    catch (error) { threw = error; }
    record('maintenance.clear_wiring', threw != null, threw ? `安全拒绝: ${String(threw.message).slice(0, 50)}` : '无效 token 未被拒绝(严重缺陷)');
  } catch (error) {
    record('maintenance.clear_wiring', false, error.message);
  }
}

console.log('\n====', results.filter(r => r.ok).length, '/', results.length, 'passed ====');
process.exit(results.every(r => r.ok) ? 0 : 1);
