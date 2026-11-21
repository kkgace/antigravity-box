// Ported from Enzoo404/gravitybox (MIT License) v1.1.2 — https://github.com/Enzoo404/gravitybox
// Windows adaptation: AntigravityBox project.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openAsarSync } from './asar.js';
import { bt } from './i18n.js';

export type ApplicationChannel = 'stable';
export type ApplicationArchitecture = 'legacy-hub' | 'wcv-hub';

export const ALLOWED_DATA_DIRECTORY_NAMES = ['antigravity'] as const;
export type DataDirectoryName = (typeof ALLOWED_DATA_DIRECTORY_NAMES)[number];

export interface InstalledChannelsInfo {
  channels: ApplicationChannel[];
  bothInstalled: boolean;
  effectiveChannel: ApplicationChannel;
}

export interface BundleCapabilities {
  architecture: ApplicationArchitecture;
  version: string;
  productName: string;
  dataDirectoryName: DataDirectoryName;
  supportsAccountSwitch: boolean;
}

const capabilityCache = new Map<string, { value: BundleCapabilities; expiresAt: number }>();

function asarPathForInstall(appPath: string): string {
  return join(appPath, 'resources', 'app.asar');
}

/** Inspect the supported stable bundle without changing the official application. */
export function probeBundleCapabilities(
  appPath: string,
  channel: ApplicationChannel = 'stable',
): BundleCapabilities {
  applicationChannel(channel);
  const now = Date.now();
  const cached = capabilityCache.get(appPath);
  if (cached && cached.expiresAt > now) return cached.value;

  const fallback: BundleCapabilities = {
    architecture: 'wcv-hub',
    version: '',
    productName: 'Antigravity',
    dataDirectoryName: 'antigravity',
    supportsAccountSwitch: true,
  };

  const asarPath = asarPathForInstall(appPath);
  let archive: ReturnType<typeof openAsarSync> | undefined;
  try {
    if (!existsSync(asarPath)) return fallback;
    archive = openAsarSync(asarPath, 16_000_000);
    const distFiles = archive.header.files?.dist?.files ?? {};
    const hasWcvArchitecture = Boolean(
      distFiles['wcvBrowserRegistry.js'] ||
      distFiles['wcvIpcHandlers.js'] ||
      distFiles['browserEngine'] ||
      distFiles['windowState.js'],
    );

    let version = '';
    let productName = fallback.productName;
    const pkgBuf = archive.readEntryBuffer(archive.header.files?.['package.json'], 256_000, 1);
    if (pkgBuf) {
      const pkg = JSON.parse(pkgBuf.toString('utf8'));
      if (typeof pkg?.version === 'string') version = pkg.version.trim();
      if (typeof pkg?.productName === 'string' && pkg.productName.trim()) productName = pkg.productName.trim();
    }

    const architecture: ApplicationArchitecture = hasWcvArchitecture
      ? 'wcv-hub'
      : 'legacy-hub';
    const dataDirectoryName: DataDirectoryName = 'antigravity';

    const resolved: BundleCapabilities = {
      architecture,
      version,
      productName,
      dataDirectoryName,
      supportsAccountSwitch: true,
    };
    capabilityCache.set(appPath, { value: resolved, expiresAt: now + 30_000 });
    return resolved;
  } catch {
    return fallback;
  } finally {
    archive?.close();
  }
}

export function applicationChannel(value: unknown): ApplicationChannel {
  if (value === undefined || value === 'stable') return 'stable';
  if (value === 'insiders') throw new Error(bt('app_target.stable_only'));
  throw new Error(bt('app_target.invalid_channel'));
}

/** Only persisted legacy configuration is migrated; explicit channel requests are rejected. */
export function savedApplicationChannel(value: unknown): ApplicationChannel {
  return value === 'insiders' ? 'stable' : applicationChannel(value);
}

/** Per-user and per-machine install roots for the stable desktop application on Windows. */
export function candidateInstallRoots(): string[] {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    join(localAppData, 'Programs', 'antigravity'),
    join(programFiles, 'Antigravity'),
    join(programFilesX86, 'Antigravity'),
  ];
}

export function detectInstalledChannels(
  preferredChannel: ApplicationChannel = 'stable',
  _applicationsDir?: string,
): InstalledChannelsInfo {
  applicationChannel(preferredChannel);
  const installed = candidateInstallRoots().some(root => existsSync(join(root, 'Antigravity.exe')));
  return {
    channels: installed ? ['stable'] : [],
    bothInstalled: false,
    effectiveChannel: 'stable',
  };
}

/** Keep identity, executable, profile, and conversation storage bound to the target while unifying user-facing label and full feature support. */
export function applicationTarget(
  channel: ApplicationChannel = 'stable',
  home = homedir(),
  options?: { appPath?: string; profile?: string; applicationsDir?: string },
) {
  applicationChannel(channel);
  const name = 'Antigravity';
  const appPath = options?.appPath
    ?? candidateInstallRoots().find(root => existsSync(join(root, 'Antigravity.exe')))
    ?? join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Programs', 'antigravity');
  const profile = options?.profile
    ?? join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), name);
  const capabilities = probeBundleCapabilities(appPath, channel);
  return {
    channel,
    name,
    label: 'Antigravity',
    bundleId: 'com.google.antigravity',
    appPath,
    executable: 'Antigravity.exe',
    profile,
    dataDirectoryName: capabilities.dataDirectoryName,
    architecture: capabilities.architecture,
    supportsAccountSwitch: true,
  };
}

export type ApplicationTarget = ReturnType<typeof applicationTarget>;

export function allApplicationTargets(home = homedir(), _applicationsDir?: string): ApplicationTarget[] {
  return [
    applicationTarget('stable', home),
  ];
}

export function targetForApp(appPath: string, home = homedir()): ApplicationTarget {
  return applicationTarget('stable', home, { appPath });
}

function normalizeForMatch(value: string): string {
  return value.replace(/\//g, '\\').toLowerCase();
}

export function matchingTargetForLanguageServerCommand(
  command: string,
  preferredTarget?: ApplicationTarget,
  home = homedir(),
): ApplicationTarget | null {
  const candidates = preferredTarget
    ? [preferredTarget, ...allApplicationTargets(home).filter(t => t.appPath !== preferredTarget.appPath)]
    : allApplicationTargets(home);
  const normalizedCommand = normalizeForMatch(command);
  for (const candidate of candidates) {
    const prefix = normalizeForMatch(`${candidate.appPath}\\resources\\bin\\language_server.exe`);
    if (!normalizedCommand.startsWith(prefix)) continue;
    const dataDirectory = command.match(/(?:^|\s)--app_data_dir(?:=|\s+)("?)([^"\s]+)\1/)?.[2];
    if (dataDirectory && dataDirectory !== candidate.dataDirectoryName) continue;
    return candidate;
  }
  return null;
}

export function channelStateDirectory(stateDir: string, _channel?: ApplicationChannel): string {
  return stateDir;
}
