/**
 * AntigravityBox — Windows process inspection for Antigravity targets.
 * Counterpart of gravitybox's `ps`/`lsof` usage: enumerates Antigravity processes
 * and verifies which process owns a loopback TCP port, via PowerShell.
 * Results are cached briefly to keep polling cheap.
 */
import { requirePowerShell } from './shell.js';

export interface ProcessInfo {
  pid: number;
  name: string;
  path: string;
  commandLine?: string;
}

const PROC_CACHE_TTL = 3_000;
const PORT_CACHE_TTL = 10_000;

let procCache: { at: number; value: ProcessInfo[] } | null = null;
const portCache = new Map<string, { at: number; value: string | null }>();

function normalizePath(value: string): string {
  return value.trim().replace(/\//g, '\\');
}

/** All running processes whose image path is under one of the given roots (or whose name matches). */
export async function findProcessesUnderRoots(
  rootPaths: string[],
  options?: { imageNames?: string[]; force?: boolean },
): Promise<ProcessInfo[]> {
  const now = Date.now();
  if (!options?.force && procCache && now - procCache.at < PROC_CACHE_TTL) {
    return filterProcesses(procCache.value, rootPaths, options?.imageNames);
  }
  const script = `
$ErrorActionPreference='SilentlyContinue'
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match '^(Antigravity|language_server)' -or ($_.ExecutablePath -like '*antigravity*') } |
  ForEach-Object {
    $p = $_.ExecutablePath
    if (-not $p) { $p = '' }
    $cl = $_.CommandLine
    if (-not $cl) { $cl = '' }
    [Console]::Out.Write("PID=$($_.ProcessId)|NAME=$($_.Name)|PATH=$p|CMD=$cl\`n")
  }
`.trim();
  const stdout = await requirePowerShell(script, { timeoutMs: 12_000 });
  const list: ProcessInfo[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^PID=(\d+)\|NAME=([^|]*)\|PATH=([^|]*)\|CMD=(.*)$/);
    if (!match) continue;
    list.push({
      pid: Number(match[1]),
      name: match[2] ?? '',
      path: normalizePath(match[3] ?? ''),
      commandLine: match[4] ?? '',
    });
  }
  procCache = { at: now, value: list };
  return filterProcesses(list, rootPaths, options?.imageNames);
}

function filterProcesses(list: ProcessInfo[], rootPaths: string[], imageNames?: string[]): ProcessInfo[] {
  const roots = rootPaths.map(normalizePath).map(p => p.toLowerCase());
  const names = (imageNames ?? []).map(n => n.toLowerCase());
  return list.filter(p => {
    const lower = p.path.toLowerCase();
    if (roots.some(root => lower.startsWith(root))) return true;
    if (names.includes(p.name.toLowerCase())) return true;
    return false;
  });
}

/** True when at least one Antigravity desktop process (or its language server) is running under the given roots. */
export async function isApplicationRunning(rootPaths: string[], executableNames = ['Antigravity.exe']): Promise<boolean> {
  const list = await findProcessesUnderRoots(rootPaths, { imageNames: [...executableNames, 'language_server.exe'] });
  return list.length > 0;
}

/** Snapshot of every process command line, with pid where available (counterpart of `ps axo command=`). */
export async function listProcessCommands(): Promise<{ pid: number; command: string }[]> {
  const script = `
$ErrorActionPreference='SilentlyContinue'
Get-CimInstance Win32_Process | ForEach-Object {
  $cl = $_.CommandLine
  if (-not $cl) { $cl = $_.ExecutablePath }
  if ($cl) { [Console]::Out.Write("PID=$($_.ProcessId)|CMD=$cl\`n") }
}
`.trim();
  const stdout = await requirePowerShell(script, { timeoutMs: 8_000 });
  const list: { pid: number; command: string }[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^PID=(\d+)\|CMD=(.*)$/);
    if (!match) continue;
    list.push({ pid: Number(match[1]), command: match[2] ?? '' });
  }
  return list;
}

/** Resolve the image path of the process listening on a loopback TCP port, or null. */
export async function processPathOfPort(port: number, options?: { force?: boolean }): Promise<string | null> {
  const key = String(port);
  const now = Date.now();
  const cached = portCache.get(key);
  if (!options?.force && cached && now - cached.at < PORT_CACHE_TTL) return cached.value;
  const script = `
$ErrorActionPreference='SilentlyContinue'
$conns = Get-NetTCPConnection -LocalPort ${port} -State Listen
foreach ($c in $conns) {
  $local = "$($c.LocalAddress):$($c.LocalPort)"
  $proc = Get-Process -Id $c.OwningProcess
  if ($proc) { [Console]::Out.Write("LISTEN=$local|PID=$($c.OwningProcess)|PATH=$($proc.Path)\`n") }
}
`.trim();
  try {
    const stdout = await requirePowerShell(script, { timeoutMs: 8_000 });
    let result: string | null = null;
    for (const line of stdout.split('\n')) {
      const match = line.match(/^LISTEN=([^|]+)\|PID=(\d+)\|PATH=(.*)$/);
      if (!match) continue;
      const local = match[1] ?? '';
      const isLoopback = local.startsWith('127.0.0.1:') || local.startsWith('[::1]:');
      if (isLoopback && match[3]) result = normalizePath(match[3]);
    }
    portCache.set(key, { at: now, value: result });
    return result;
  } catch {
    portCache.set(key, { at: now, value: null });
    return null;
  }
}
