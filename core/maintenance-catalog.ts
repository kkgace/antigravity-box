// Ported from Enzoo404/gravitybox (MIT License) v1.1.2 — https://github.com/Enzoo404/gravitybox
// Windows adaptation: AntigravityBox project.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { bt } from './i18n.js';

export type CacheCategory = 'safe' | 'stateful';
export type CacheSection = 'runtime' | 'history';

export interface CacheItemMetadata {
  title: string;
  subtitle: string;
  icon: string;
  category: CacheCategory;
  section?: CacheSection;
  defaultSelected: boolean;
  impactWarning?: string;
}

// 核心常驻无损缓存（始终展示，默认勾选）
export const CACHE_NAMES = ['Cache', 'Code Cache', 'GPUCache'] as const;

// 扩展无损加速与废弃垃圾缓存（存在时自动发现并纳入，默认勾选，应删尽删）
export const EXTENDED_CACHE_NAMES = [
  'DawnCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'CachedData',
  'CachedExtensionVSIXs',
  'CachedProfilesData',
  'Crashpad',
  'logs',
  'blob_storage',
] as const;

// 多路径聚合无损缓存与孤儿残留（存在非零体积或受阻时纳入分组 1，默认勾选）
export const MULTI_SAFE_CACHE_NAMES = [
  'PartitionsCache',
  'AgentBrowserCache',
  'OrphanAgentData',
] as const;

// Agent 历史深度瘦身项（分组 2，按保留天数扫描，默认不勾选，供用户按需勾选）
export const HISTORY_SLIMMING_NAMES = [
  'AgentTaskStepLogs',
  'AgentVerboseTranscripts',
  'AgentSubagentDatabases',
] as const;

// 受保护的会话、站点存储与网络授权状态目录（严禁纳入清理，仅作只读保护统计）
export const STATEFUL_CACHE_NAMES = [
  'Service Worker',
  'Session Storage',
  'WebStorage',
  'Local Storage',
  'Cookies',
  'Network Persistent State',
] as const;

export const ALL_SAFE_CACHE_NAMES = [
  ...CACHE_NAMES,
  ...EXTENDED_CACHE_NAMES,
  ...MULTI_SAFE_CACHE_NAMES,
] as const;

export const ALL_ALLOWED_CACHE_NAMES = [
  ...ALL_SAFE_CACHE_NAMES,
  ...HISTORY_SLIMMING_NAMES,
] as const;

export const PARTITION_SAFE_SUBDIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'blob_storage',
] as const;

export const BROWSER_TOP_SAFE_SUBDIRS = [
  'GraphiteDawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
  'GrShaderCache',
  'component_crx_cache',
  'WasmTtsEngine',
  'Crashpad',
] as const;

export const BROWSER_PROFILE_SAFE_SUBDIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'blob_storage',
  join('Service Worker', 'CacheStorage'),
  join('Service Worker', 'ScriptCache'),
] as const;

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeRetentionDays(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const rounded = Math.max(0, Math.min(365, Math.floor(raw)));
    return rounded;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(365, Math.floor(parsed)));
    }
  }
  return 7;
}

export const MAINTENANCE_SCOPES = ['runtime_cache', 'history_logs'] as const;
export type MaintenanceScope = (typeof MAINTENANCE_SCOPES)[number];

export function normalizeMaintenanceScopes(raw: unknown): MaintenanceScope[] {
  if (raw === undefined) {
    return ['runtime_cache'];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw Error(bt('maintenance.err.invalid_selection'));
  }
  const allowed = new Set<string>(MAINTENANCE_SCOPES);
  const selected = new Set<MaintenanceScope>();
  for (const item of raw) {
    if (typeof item !== 'string' || !allowed.has(item)) {
      throw Error(bt('maintenance.err.invalid_selection'));
    }
    selected.add(item as MaintenanceScope);
  }
  return MAINTENANCE_SCOPES.filter(scope => selected.has(scope));
}

export function namesForMaintenanceScopes(scopes: readonly MaintenanceScope[]): string[] {
  const names: string[] = [];
  if (scopes.includes('runtime_cache')) {
    names.push(...ALL_SAFE_CACHE_NAMES);
  }
  if (scopes.includes('history_logs')) {
    names.push(...HISTORY_SLIMMING_NAMES);
  }
  return Array.from(new Set(names));
}

interface CacheCatalogSpec {
  key: string;
  icon: string;
  category: CacheCategory;
  section?: CacheSection;
  defaultSelected: boolean;
  hasImpact?: boolean;
}

const CACHE_CATALOG_SPECS: Record<string, CacheCatalogSpec> = {
  'Cache': { key: 'cache', icon: 'internaldrive', category: 'safe', section: 'runtime', defaultSelected: true },
  'Code Cache': { key: 'code_cache', icon: 'cpu', category: 'safe', section: 'runtime', defaultSelected: true },
  'GPUCache': { key: 'gpu_cache', icon: 'sparkles.rectangle.stack', category: 'safe', section: 'runtime', defaultSelected: true },
  'DawnCache': { key: 'dawn_cache', icon: 'cube.transparent', category: 'safe', section: 'runtime', defaultSelected: true },
  'DawnWebGPUCache': { key: 'dawn_webgpu_cache', icon: 'cube.transparent', category: 'safe', section: 'runtime', defaultSelected: true },
  'DawnGraphiteCache': { key: 'dawn_graphite_cache', icon: 'cube.transparent', category: 'safe', section: 'runtime', defaultSelected: true },
  'GraphiteDawnCache': { key: 'graphite_dawn_cache', icon: 'sparkles.rectangle.stack', category: 'safe', section: 'runtime', defaultSelected: true },
  'ShaderCache': { key: 'shader_cache', icon: 'sparkles.rectangle.stack', category: 'safe', section: 'runtime', defaultSelected: true },
  'CachedData': { key: 'cached_data', icon: 'memorychip', category: 'safe', section: 'runtime', defaultSelected: true },
  'CachedExtensionVSIXs': { key: 'cached_vsix', icon: 'shippingbox', category: 'safe', section: 'runtime', defaultSelected: true },
  'CachedProfilesData': { key: 'cached_profiles', icon: 'doc.badge.gearshape', category: 'safe', section: 'runtime', defaultSelected: true },
  'Crashpad': { key: 'crashpad', icon: 'exclamationmark.triangle', category: 'safe', section: 'runtime', defaultSelected: true },
  'logs': { key: 'logs', icon: 'doc.text', category: 'safe', section: 'runtime', defaultSelected: true },
  'blob_storage': { key: 'blob_storage', icon: 'archivebox', category: 'safe', section: 'runtime', defaultSelected: true },
  'PartitionsCache': { key: 'partitions_cache', icon: 'square.split.2x2', category: 'safe', section: 'runtime', defaultSelected: true },
  'AgentBrowserCache': { key: 'agent_browser_cache', icon: 'globe', category: 'safe', section: 'runtime', defaultSelected: true },
  'OrphanAgentData': { key: 'orphan_agent_data', icon: 'trash.slash', category: 'safe', section: 'runtime', defaultSelected: true },
  'AgentTaskStepLogs': { key: 'task_step_logs', icon: 'terminal', category: 'stateful', section: 'history', defaultSelected: false, hasImpact: true },
  'AgentVerboseTranscripts': { key: 'verbose_transcripts', icon: 'doc.on.doc', category: 'stateful', section: 'history', defaultSelected: false, hasImpact: true },
  'AgentSubagentDatabases': { key: 'subagent_dbs', icon: 'arrow.triangle.branch', category: 'stateful', section: 'history', defaultSelected: false, hasImpact: true },
  'Service Worker': { key: 'service_worker', icon: 'gearshape.2', category: 'stateful', defaultSelected: false, hasImpact: true },
  'Session Storage': { key: 'session_storage', icon: 'rectangle.stack', category: 'stateful', defaultSelected: false, hasImpact: true },
  'WebStorage': { key: 'web_storage', icon: 'globe', category: 'stateful', defaultSelected: false, hasImpact: true },
  'Local Storage': { key: 'local_storage', icon: 'externaldrive.badge.person.crop', category: 'stateful', defaultSelected: false, hasImpact: true },
  'Cookies': { key: 'cookies', icon: 'key.horizontal', category: 'stateful', defaultSelected: false, hasImpact: true },
  'Network Persistent State': { key: 'network_state', icon: 'network', category: 'stateful', defaultSelected: false, hasImpact: true },
};

export function getCacheMetadata(name: string): CacheItemMetadata | undefined {
  const spec = CACHE_CATALOG_SPECS[name];
  if (!spec) return undefined;
  return {
    title: bt(`maintenance.catalog.${spec.key}.title`),
    subtitle: bt(`maintenance.catalog.${spec.key}.sub`),
    icon: spec.icon,
    category: spec.category,
    ...(spec.section ? { section: spec.section } : {}),
    defaultSelected: spec.defaultSelected,
    ...(spec.hasImpact ? { impactWarning: bt(`maintenance.catalog.${spec.key}.impact`) } : {}),
  };
}

export const CACHE_METADATA: Record<string, CacheItemMetadata> = new Proxy({} as Record<string, CacheItemMetadata>, {
  get(target, prop, receiver) {
    if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(CACHE_CATALOG_SPECS, prop)) {
      return getCacheMetadata(prop);
    }
    return Reflect.get(target, prop, receiver);
  },
  has(_target, prop) {
    return typeof prop === 'string' && Object.prototype.hasOwnProperty.call(CACHE_CATALOG_SPECS, prop);
  },
  ownKeys() {
    return Object.keys(CACHE_CATALOG_SPECS);
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(CACHE_CATALOG_SPECS, prop)) {
      return { enumerable: true, configurable: true, value: getCacheMetadata(prop) };
    }
    return undefined;
  },
});

const execFileAsync = promisify(execFile);
const PROCESS_SNAPSHOT_TTL_MS = 250;
let cachedProcessCommands: { at: number; commands: string[] | null } | null = null;
let inFlightProcessCommands: Promise<string[] | null> | null = null;

export async function readProcessCommands(): Promise<string[] | null> {
  const now = Date.now();
  if (cachedProcessCommands && now - cachedProcessCommands.at < PROCESS_SNAPSHOT_TTL_MS) {
    return cachedProcessCommands.commands;
  }
  if (inFlightProcessCommands) {
    return inFlightProcessCommands;
  }
  const task = (async (): Promise<string[] | null> => {
    try {
      let stdout: string;
      if (process.platform === 'win32') {
        // Windows 适配:无 /bin/ps,且 Git Bash 的 ps 看不到原生进程。用 CIM 读取全部进程
        // 命令行(含主程序与 sidecar);EncodedCommand 规避引号转义。探测失败返回 null 时
        // 上层 antigravityRunning 会 fail-open —— 因此超时必须足够宽,不能让安全闸失效。
        const encoded = Buffer.from(
          'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }',
          'utf16le',
        ).toString('base64');
        ({ stdout } = await execFileAsync('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
          { timeout: 8000, maxBuffer: 32 * 1024 * 1024 }));
      } else {
        ({ stdout } = await execFileAsync('/bin/ps', ['-axo', 'command='], { timeout: 3000 }));
      }
      const commands = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      cachedProcessCommands = { at: Date.now(), commands };
      return commands;
    } catch {
      cachedProcessCommands = null;
      return null;
    }
  })();
  inFlightProcessCommands = task;
  try {
    return await task;
  } finally {
    if (inFlightProcessCommands === task) {
      inFlightProcessCommands = null;
    }
  }
}

// Windows 适配:上游以 '/Applications/Antigravity.app' 为缺省根做双根校验;这里以 Windows
// 安装根为缺省,保持"未显式传入 appPath 时仍能识别官方安装形态"的语义(含语言服务子进程)。
// Win32_Process 返回的命令行对带空格路径会加引号,且本机 sidecar 经 cmd.exe 包装从
// %APPDATA%\Antigravity\bin 启动 —— 两者都必须被识别,否则运行态闸门形同虚设。
export function hasAntigravityCommand(commands: string[], appPath = ''): boolean {
  const defaultRoot = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Programs', 'antigravity')
    : join('C:', 'Program Files', 'Antigravity');
  const sidecarBin = process.env.APPDATA ? join(process.env.APPDATA, 'Antigravity', 'bin') : '';
  const normalize = (value: string) => value.replace(/^"+/, '').replace(/\//g, '\\').toLowerCase().trim();
  const appRoots = Array.from(new Set([
    appPath,
    appPath ? dirname(appPath) : '',
    defaultRoot,
  ].filter(Boolean))) as string[];
  const roots = appRoots.map(p => normalize(p) + '\\');
  const lsPrefixes = appRoots.map(p => normalize(p + '\\resources\\bin\\language_server'));
  const sidecarPrefix = sidecarBin ? normalize(sidecarBin) + '\\' : '';
  return commands.some(trimmed => {
    const normalized = normalize(trimmed);
    return roots.some(prefix => normalized.startsWith(prefix)) ||
      lsPrefixes.some(prefix => normalized.startsWith(prefix) || normalized.includes(prefix)) ||
      (sidecarPrefix !== '' && normalized.includes(sidecarPrefix));
  });
}

export function hasBrowserProfileCommand(commands: string[], browserProfileDir: string): boolean {
  if (!browserProfileDir) return false;
  return commands.some(trimmed => trimmed.includes(browserProfileDir));
}

export async function antigravityRunning(appPath?: string) {
  const commands = await readProcessCommands();
  return commands ? hasAntigravityCommand(commands, appPath) : false;
}

export async function browserProfileRunning(browserProfileDir: string): Promise<boolean> {
  if (!browserProfileDir) return false;
  const commands = await readProcessCommands();
  return commands ? hasBrowserProfileCommand(commands, browserProfileDir) : false;
}

export interface CacheMaintenanceOptions {
  appPath?: string;
  stateDir?: string;
  fallbackTrashDir?: string;
  geminiDir?: string;
  browserRunning?: () => Promise<boolean>;
  archiveDatabases?: (dbPaths: string[]) => Promise<unknown>;
  onMutated?: () => void | Promise<void>;
}

export interface SubTargetSpec {
  path: string;
  isUsageDb?: boolean;
}

export interface InspectedCacheEntry {
  name: string;
  title: string;
  subtitle: string;
  icon: string;
  category: CacheCategory;
  section: CacheSection;
  defaultSelected: boolean;
  impactWarning?: string;
  bytes: number;
  fileCount: number;
  itemCount?: number;
  lastModifiedAt: number;
  exists: boolean;
  clearable: boolean;
  fingerprint: string;
  reason?: string;
  isSingleLegacyRoot: boolean;
  subTargets: SubTargetSpec[];
}

export interface ConversationIndexSnapshot {
  available: boolean;
  summaryMap: Map<string, { parentId: string; status: string }>;
  runningTreeIds: Set<string>;
  archivedTreeIds: Set<string>;
}

export function isStrictSubpath(parentDir: string, candidatePath: string): boolean {
  const rel = relative(resolve(parentDir), resolve(candidatePath));
  return Boolean(rel && !rel.startsWith('..') && !rel.includes(`..${sep}`) && rel !== '.');
}

