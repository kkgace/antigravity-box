// Ported from Enzoo404/gravitybox (MIT License) v1.1.2 — https://github.com/Enzoo404/gravitybox
// Windows adaptation: AntigravityBox project.
import { readFile, stat as fsStat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openAsarArchive } from './asar.js';
import { assertLoopback } from './cdp.js';
import { targetForApp } from './application-target.js';
import { cacheDir } from '../windows/paths.js';
import { processPathOfPort, isApplicationRunning as isAppRunningUnderRoots } from '../windows/processes.js';
import { bt } from './i18n.js';

export type Endpoint = { port: number; pid: number; browserURL: string; appVersion: string; legacyPatch: boolean; appPath?: string; profile?: string };

type PersistedBundleEntry = {
  value: { version: string; legacyPatch: boolean };
  verifiedAt: number;
  asarMtimeMs: number;
  asarSize: number;
  execMtimeMs: number;
  execSize: number;
};

const bundleCache = new Map<string, PersistedBundleEntry & { expiresAt: number; hardExpiresAt: number }>();
const inFlightBundleInspect = new Map<string, Promise<{ version: string; legacyPatch: boolean }>>();
const BUNDLE_DISK_CACHE_PATH = join(cacheDir(), 'bundle-verify-cache-v1.json');
let diskBundleCacheLoaded = false;

async function ensureDiskBundleCacheLoaded(): Promise<void> {
  if (diskBundleCacheLoaded) return;
  diskBundleCacheLoaded = true;
  try {
    const parsed = JSON.parse(await readFile(BUNDLE_DISK_CACHE_PATH, 'utf8'));
    if (!parsed || parsed.schema !== 1 || typeof parsed.entries !== 'object' || !parsed.entries) return;
    const now = Date.now();
    for (const [k, raw] of Object.entries<any>(parsed.entries)) {
      if (
        raw?.value &&
        typeof raw.value.version === 'string' &&
        typeof raw.value.legacyPatch === 'boolean' &&
        typeof raw.verifiedAt === 'number' &&
        now - raw.verifiedAt < 24 * 3600_000
      ) {
        bundleCache.set(k, {
          ...raw,
          expiresAt: 0,
          hardExpiresAt: raw.verifiedAt + 24 * 3600_000,
        });
      }
    }
  } catch { /* first run or unreadable cache; rebuild in memory */ }
}

async function saveDiskBundleCache(): Promise<void> {
  try {
    const entries: Record<string, PersistedEntryOnly> = {};
    for (const [k, entry] of bundleCache.entries()) {
      const { expiresAt: _e, hardExpiresAt: _h, ...persisted } = entry;
      entries[k] = persisted;
    }
    await mkdir(BUNDLE_DISK_CACHE_PATH.slice(0, BUNDLE_DISK_CACHE_PATH.lastIndexOf('\\')), { recursive: true });
    await writeFile(BUNDLE_DISK_CACHE_PATH, JSON.stringify({ schema: 1, entries }) + '\n');
  } catch { /* cache is best-effort */ }
}
type PersistedEntryOnly = PersistedBundleEntry;

async function inspectBundleUncached(appPath: string): Promise<{ version: string; legacyPatch: boolean }> {
  const target = targetForApp(appPath);
  const asarPath = join(appPath, 'resources', 'app.asar');
  const execPath = join(appPath, target.executable);
  const archive = await openAsarArchive(asarPath, 16_000_000);
  try {
    let version = '';
    const pkgBuf = await archive.readEntryBuffer(archive.header.files?.['package.json'], 256_000, 1);
    if (pkgBuf) {
      const pkg = JSON.parse(pkgBuf.toString('utf8'));
      if (typeof pkg?.version === 'string') version = pkg.version.trim();
    }
    let legacyPatch = false;
    for (const name of ['preload.js', 'main.js', 'utils.js']) {
      const entry = archive.header.files?.dist?.files?.[name];
      if (!entry || entry.unpacked) continue;
      const bytes = await archive.readEntryBuffer(entry, 3_000_000, 1);
      if (!bytes) continue;
      const text = bytes.toString();
      legacyPatch ||= /ANTIGRAVITY CHINESE LOCALIZATION START|injectAntigravityI18n|__ANTIGRAVITY_I18N_DATA__|createI18nEngine|__ag_hanhua_engine__/.test(text);
    }
    return { version, legacyPatch };
  } finally {
    await archive.close();
  }
}

/**
 * Inspect the installed bundle: version plus third-party package-patch detection.
 * On Windows the Authenticode signature covers the executable, not app.asar, so the
 * on-disk mtime/size fingerprint and in-archive patch markers are the tamper signals.
 */
export async function inspectBundle(appPath: string): Promise<{ version: string; legacyPatch: boolean }> {
  const now = Date.now();
  const memCached = bundleCache.get(appPath);
  if (memCached && memCached.expiresAt > now) return memCached.value;

  const inflight = inFlightBundleInspect.get(appPath);
  if (inflight) return inflight;

  const work = (async () => {
    await ensureDiskBundleCacheLoaded();
    const asarPath = join(appPath, 'resources', 'app.asar');
    const execPath = join(appPath, targetForApp(appPath).executable);
    const cached = bundleCache.get(appPath);
    if (cached && cached.hardExpiresAt > Date.now()) {
      try {
        const [aStat, eStat] = await Promise.all([fsStat(asarPath), fsStat(execPath)]);
        if (aStat.mtimeMs === cached.asarMtimeMs && aStat.size === cached.asarSize &&
            eStat.mtimeMs === cached.execMtimeMs && eStat.size === cached.execSize) {
          cached.expiresAt = Date.now() + 120_000;
          return cached.value;
        }
      } catch { /* stat failed; fall through to full inspect */ }
    }
    const value = await inspectBundleUncached(appPath);
    const completedAt = Date.now();
    try {
      const [aStat, eStat] = await Promise.all([fsStat(asarPath), fsStat(execPath)]);
      bundleCache.set(appPath, {
        value,
        verifiedAt: completedAt,
        expiresAt: completedAt + 120_000,
        hardExpiresAt: completedAt + 24 * 3600_000,
        asarMtimeMs: aStat.mtimeMs,
        asarSize: aStat.size,
        execMtimeMs: eStat.mtimeMs,
        execSize: eStat.size,
      });
      void saveDiskBundleCache();
    } catch {
      bundleCache.set(appPath, { value, verifiedAt: completedAt, expiresAt: completedAt + 120_000, hardExpiresAt: completedAt + 24 * 3600_000, asarMtimeMs: 0, asarSize: 0, execMtimeMs: 0, execSize: 0 });
    }
    return value;
  })().finally(() => {
    inFlightBundleInspect.delete(appPath);
  });

  inFlightBundleInspect.set(appPath, work);
  return work;
}

function isOwnExecutablePath(ownerPath: string | null, appPath: string): boolean {
  if (!ownerPath) return false;
  const normalize = (value: string) => value.replace(/\//g, '\\').toLowerCase();
  return normalize(ownerPath) === normalize(join(appPath, targetForApp(appPath).executable));
}

async function discoverSingle(appPath: string, profile: string): Promise<Endpoint | undefined> {
  let contents: string;
  try { contents = await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return undefined; }
  const port = Number(contents.split('\n')[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  const ownerPath = await processPathOfPort(port);
  if (!isOwnExecutablePath(ownerPath, appPath)) return undefined;
  const bundle = await inspectBundle(appPath);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  } catch { return undefined; }
  if (!response.ok) return undefined;
  const version = await response.json() as Record<string, string>;
  if (!version.webSocketDebuggerUrl) return undefined;
  const ws = assertLoopback(version.webSocketDebuggerUrl);
  if (Number(ws.port) !== port) throw new Error(bt('discovery.port_mismatch'));
  return { port, pid: 0, browserURL: ws.href, appVersion: bundle.version, legacyPatch: bundle.legacyPatch, appPath, profile };
}

export async function discover(appPath: string, profile: string): Promise<Endpoint | undefined> {
  return discoverSingle(appPath, profile);
}

/** Read-only check whether the stable desktop application main process is currently running. */
export async function isApplicationRunning(appPath: string): Promise<boolean> {
  if (!appPath) return false;
  try {
    targetForApp(appPath);
  } catch {
    return false;
  }
  return isAppRunningUnderRoots([appPath]);
}

export function allowedTarget(target: { type: string; url: string }, fixtureOrigin?: string): boolean {
  if (target.type !== 'page') return false;
  try {
    const url = new URL(target.url);
    if (fixtureOrigin) return url.origin === fixtureOrigin && url.pathname === '/fixture';
    const blockedPaths = /^\/(?:api|oauth|login|browser|preview)(?:\/|$)/i;
    const pathAllowed = !blockedPaths.test(url.pathname) && (
      url.pathname === '/' ||
      /^\/(?:history|sidecars|customizations|automations|settings|settings-standalone|terminal-standalone|new-project|multi|artifact|s|chatski-connect)(?:\/.*)?$/i.test(url.pathname) ||
      /^\/c(?:\/|\/(?:[0-9a-f-]{36}|_new)(?:\/.*)?)?$/i.test(url.pathname) ||
      /^\/(?:forked|view|battle)\/.*$/i.test(url.pathname)
    );
    return url.protocol === 'https:' && url.hostname === '127.0.0.1' && !!url.port && pathAllowed && !url.username && !url.password;
  } catch { return false; }
}

const verifiedPortCache = new Map<string, { valid: boolean; expiresAt: number }>();

export async function verifyPageService(url: string, appPath: string): Promise<boolean> {
  if (!allowedTarget({ type: 'page', url })) return false;
  const port = Number(new URL(url).port);
  const cacheKey = `${appPath}:${port}`;
  const now = Date.now();
  const cached = verifiedPortCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.valid;

  try {
    const ownerPath = await processPathOfPort(port, { force: true });
    const normalize = (value: string) => value.replace(/\//g, '\\').toLowerCase();
    const valid = !!ownerPath && (
      normalize(ownerPath) === normalize(join(appPath, 'resources', 'bin', 'language_server.exe')) ||
      normalize(ownerPath).startsWith(normalize(appPath + '\\'))
    );
    if (valid) verifiedPortCache.set(cacheKey, { valid: true, expiresAt: now + 60_000 });
    else verifiedPortCache.delete(cacheKey);
    return valid;
  } catch {
    verifiedPortCache.delete(cacheKey);
    return false;
  }
}

const verifiedLsPidPortsCache = new Map<string, { ports: number[]; expiresAt: number }>();

/** Verify the real executable before trusting a language-server listener, returning verified loopback IPv4 ports. */
export async function resolveVerifiedLanguageServerPorts(pid: number, appPath: string): Promise<number[] | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const cacheKey = `${pid}:${appPath}`;
  const now = Date.now();
  const cachedPorts = verifiedLsPidPortsCache.get(cacheKey);
  if (cachedPorts && cachedPorts.expiresAt > now) {
    try {
      process.kill(pid, 0);
      return cachedPorts.ports;
    } catch {
      verifiedLsPidPortsCache.delete(cacheKey);
      return null;
    }
  }
  try {
    // Confirm the PID is the language server shipped inside the official install.
    const script = `
$ErrorActionPreference='SilentlyContinue'
$p = Get-Process -Id ${pid}
if (-not $p) { exit 0 }
[Console]::Out.Write("EXE=$($p.Path)\`n")
$c = Get-NetTCPConnection -OwningProcess ${pid} -State Listen
foreach ($x in $c) { [Console]::Out.Write("PORT=$($x.LocalAddress):$($x.LocalPort)\`n") }
`.trim();
    const { requirePowerShell } = await import('../windows/shell.js');
    const stdout = await requirePowerShell(script, { timeoutMs: 8_000 });
    let exePath: string | null = null;
    const ports: number[] = [];
    for (const line of stdout.split('\n')) {
      const exe = line.match(/^EXE=(.*)$/);
      if (exe?.[1]) exePath = exe[1];
      const port = line.match(/^PORT=127\.0\.0\.1:(\d+)$/);
      if (port?.[1]) ports.push(Number(port[1]));
    }
    const normalize = (value: string) => value.replace(/\//g, '\\').toLowerCase();
    if (!exePath || normalize(exePath) !== normalize(join(appPath, 'resources', 'bin', 'language_server.exe'))) return null;
    const unique = Array.from(new Set(ports));
    if (unique.length > 0) verifiedLsPidPortsCache.set(cacheKey, { ports: unique, expiresAt: Date.now() + 15_000 });
    return unique;
  } catch {
    return null;
  }
}
