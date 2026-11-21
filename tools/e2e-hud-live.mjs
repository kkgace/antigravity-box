// AntigravityBox M2 真机 e2e — 带调试端口重启 Antigravity 并验证完整注入链。
// 协议:温和退出请求(不强杀)→ 轮询等待 → --remote-debugging-port=0 重启 → CDP 发现 → 控制器连接。
// 本机若检测到第三方补丁(legacyPatch),零修改策略按设计进入 legacy-blocked 闸门 — 这同样是链路验证。
import { applicationTarget } from '../dist/core/application-target.js';
import { discover, isApplicationRunning } from '../dist/core/discovery.js';
import { safeRelaunchForDebug } from '../dist/windows/lifecycle.js';
import { stateDir, defaultGeminiDir } from '../dist/windows/paths.js';
import { HudService } from '../dist/electron/hud.js';

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const target = applicationTarget();
const wasRunning = await isApplicationRunning(target.appPath);
console.log(`重启前:Antigravity 运行中=${wasRunning}`);

// 1. 安全重启协议
{
  try {
    const result = await safeRelaunchForDebug(target.appPath);
    record('lifecycle.safe_relaunch', result.ok, `phase=${result.phase}`);
  } catch (error) {
    record('lifecycle.safe_relaunch', false, error.message);
  }
}

// 2. CDP 端点发现(重启后 DevToolsActivePort 就绪)
let endpoint;
{
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try { endpoint = await discover(target.appPath, target.profile); } catch { /* 重试 */ }
    if (endpoint) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  record('discovery.cdp_live', !!endpoint, endpoint ? `port=${endpoint.port} appVersion=${endpoint.appVersion} legacyPatch=${endpoint.legacyPatch}` : '45s 内未发现端点');
}

// 3. 控制器连接与注入策略(connected = 注入成功;legacy-blocked = 第三方补丁闸门按设计拦截)
{
  let final = null;
  const hud = new HudService(target.appPath, target.profile, defaultGeminiDir(), stateDir(), () => {});
  try {
    await hud.start();
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      final = await hud.status();
      if (['connected', 'legacy-blocked'].includes(String(final.mode))) break;
      await new Promise(r => setTimeout(r, 1500));
    }
    const mode = String(final?.mode ?? '');
    const windows = final?.windows ?? 0;
    const acceptable = mode === 'connected' ? true : mode === 'legacy-blocked' ? true : false;
    record('hud.live_injection', acceptable, `mode=${mode} windows=${windows} appVersion=${final?.appVersion ?? '?'} translation=${final?.translationEnabled ?? '?'} message=${String(final?.message ?? '').slice(0, 60)}`);
  } catch (error) {
    record('hud.live_injection', false, error.message);
  } finally {
    await hud.stop();
  }
}

console.log('\n====', results.filter(r => r.ok).length, '/', results.length, 'passed ====');
process.exit(results.every(r => r.ok) ? 0 : 1);
