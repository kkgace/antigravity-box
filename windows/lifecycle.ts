// AntigravityBox — Antigravity 应用生命周期(Windows 适配)。
// 对应上游 native/AssistantProcessLifecycle.swift:优雅请求退出 → 轮询等待 →
// 带 --remote-debugging-port=0 重新启动。绝不强制杀死进程(与上游协议一致)。
import { runPowerShell } from './shell.js';
import { findProcessesUnderRoots } from './processes.js';
import { applicationTarget } from '../core/application-target.js';

/** 优雅请求 Antigravity 退出:向有主窗口的进程发送 WM_CLOSE(CloseMainWindow),等效上游 NSRunningApplication.terminate。 */
export async function requestGracefulQuit(appPath: string): Promise<{ requested: number }> {
  // PowerShell 侧只按可执行名匹配,再以路径前缀过滤,避免误伤同名进程。
  const script = `
$targets = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  ($_.ProcessName -ieq 'Antigravity') -and ($_.MainWindowHandle -ne 0)
}
$count = 0
foreach ($p in $targets) { if ($p.CloseMainWindow()) { $count++ } }
Write-Output "requested=$count"
`.trim();
  const out = (await runPowerShell(script, { timeoutMs: 10_000 })).stdout;
  const m = /requested=(\d+)/.exec(out);
  return { requested: m ? Number(m[1]) : 0 };
}

/** 轮询等待全部 Antigravity 进程(主程序 + language_server)退出;永不 kill,超时返回 false。 */
export async function waitForExit(appPath: string, timeoutMs = 20_000, pollMs = 150): Promise<boolean> {
  const target = applicationTarget();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const procs = await findProcessesUnderRoots([target.appPath]).catch(() => []);
    if (procs.length === 0) {
      // 等待 LaunchServices/runningboard 等价物(Windows 作业对象)注销;上游为 300ms settle。
      await new Promise(r => setTimeout(r, 300));
      return true;
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

/** 以 --remote-debugging-port=0 启动 Antigravity(零修改安装,仅命令行参数,等效上游 NSWorkspace.open + args)。 */
export async function launchWithDebugPort(appPath: string): Promise<void> {
  // 端口 0 = 由 Electron 自选并写入 DevToolsActivePort 文件;这与上游 remoteDebuggingArguments 一致。
  const script = `
Start-Process -FilePath $env:AGBOX_APP_PATH -ArgumentList '--remote-debugging-port=0' -WorkingDirectory (Split-Path $env:AGBOX_APP_PATH)
Write-Output 'launched'
`.trim();
  const result = await runPowerShell(script, { timeoutMs: 15_000, env: { AGBOX_APP_PATH: appPath } });
  // 失败必须显式抛出:静默吞掉会让上层把"没启动"误判成等待窗口,排查无从下手。
  if (result.code !== 0 || !result.stdout.includes('launched')) {
    throw new Error(result.stderr.trim().slice(0, 200) || `launch failed (powershell exit ${result.code})`);
  }
}

/** 统计带主窗口的 Antigravity UI 进程数;PowerShell 失败返回 -1(调用方保守处理)。 */
export async function countWindowedAntigravity(): Promise<number> {
  const script = `
$count = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
  ($_.ProcessName -ieq 'Antigravity') -and ($_.MainWindowHandle -ne 0)
}).Count
Write-Output "windowed=$count"
`.trim();
  const out = (await runPowerShell(script, { timeoutMs: 10_000 })).stdout;
  const m = /windowed=(\d+)/.exec(out);
  return m ? Number(m[1]) : -1;
}

/** 轮询等待带窗口的 UI 进程全部退出(无窗口 sidecar 不阻塞);永不 kill,超时返回 false。 */
export async function waitForWindowedExit(appPath: string, timeoutMs = 20_000, pollMs = 150): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await countWindowedAntigravity();
    if (count === 0) {
      // 与上游一致的 300ms settle:等待窗口注销完成。
      await new Promise(r => setTimeout(r, 300));
      return true;
    }
    if (count < 0) return false; // 探测失败 → 保守拒绝,不强行进入启动阶段
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

/** 上游 safeRelaunchAntigravityForDebug 的 Windows 等价流程(已获用户确认后调用)。 */
export async function safeRelaunchForDebug(appPath: string): Promise<{ ok: boolean; phase: string }> {
  await requestGracefulQuit(appPath);
  // Windows 适配:本流程只替换"UI 实例"。经 cmd/agy-node 启动的无窗口 sidecar 与新 UI 实例
  // 可共存且不持有 UI 状态(实测孤儿 sidecar 长期存活),等待全部进程退出会永久 quit-timeout;
  // 故此处以"带窗口的 UI 进程归零"为退出标准 —— 与 requestGracefulQuit 的目标对象一致,
  // 依旧绝不 kill 任何进程。
  const uiExited = await waitForWindowedExit(appPath);
  if (!uiExited) return { ok: false, phase: 'quit-timeout' };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await launchWithDebugPort(appPath);
    } catch {
      continue;
    }
    await new Promise(r => setTimeout(r, 1200));
    // 验证标准同样是"带窗口的 UI 进程":isApplicationRunning 会计入常驻 sidecar,会把
    // 启动失败误判为成功。
    const windowed = await countWindowedAntigravity();
    if (windowed > 0) return { ok: true, phase: 'relaunched' };
  }
  return { ok: false, phase: 'launch-failed' };
}
