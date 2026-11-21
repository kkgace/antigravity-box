// AntigravityBox — HUD 真机注入(UI 已退出时直接带调试端口启动;UI 运行中则拒绝,绝不打断用户)。
// 与 e2e-hud-live 的差异:不经过温和退出阶段(UI 关闭时无需退出),直接 launchWithDebugPort。
// 预期结局:connected(注入成功)或 legacy-blocked(第三方补丁闸门按设计拦截)——两者均为链路验证通过。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { applicationTarget } from '../dist/core/application-target.js';
import { discover } from '../dist/core/discovery.js';
import { launchWithDebugPort } from '../dist/windows/lifecycle.js';
import { stateDir, defaultGeminiDir } from '../dist/windows/paths.js';
import { HudService } from '../dist/electron/hud.js';

const execFileAsync = promisify(execFile);
const target = applicationTarget();

// 0. 有窗口的 UI 进程存在则中止(绝不在用户使用时重启应用;无窗口 sidecar 不算 UI)
{
  const encoded = Buffer.from(
    "Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Measure-Object | ForEach-Object { $_.Count }",
    'utf16le',
  ).toString('base64');
  const { stdout } = await execFileAsync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 15000 });
  const windowed = parseInt(stdout.trim(), 10) || 0;
  if (windowed > 0) {
    console.log(`RESULT: ui-running(${windowed} 个窗口) — 中止,不打断用户会话`);
    process.exit(2);
  }
  console.log('UI 已退出 ✓(无窗口 sidecar 不阻塞新实例启动)');
}

// 1. 带调试端口启动
await launchWithDebugPort(target.appPath);
console.log('已请求带 --remote-debugging-port=0 启动 Antigravity');

// 2. CDP 端点发现
let endpoint = null;
{
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try { endpoint = await discover(target.appPath, target.profile); } catch { /* 重试 */ }
    if (endpoint) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log('CDP 端点:', endpoint
    ? `port=${endpoint.port} appVersion=${endpoint.appVersion} legacyPatch=${endpoint.legacyPatch}`
    : '45s 内未发现 ✗');
}

// 3. 控制器连接与注入策略
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
  console.log('HUD 状态:', JSON.stringify({
    mode: final?.mode,
    windows: final?.windows,
    appVersion: final?.appVersion,
    translation: final?.translationEnabled,
    message: String(final?.message ?? '').slice(0, 80),
  }));
} finally {
  await hud.stop();
}

const ok = !!endpoint && ['connected', 'legacy-blocked'].includes(String(final?.mode));
console.log(ok ? 'RESULT: live-hud-ok ✓' : 'RESULT: live-hud-failed ✗');
process.exit(ok ? 0 : 1);
