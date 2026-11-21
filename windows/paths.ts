/**
 * AntigravityBox — Windows path constants and shared platform helpers.
 * Single source of truth for our own data locations and the target app layout.
 */
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Stats } from 'node:fs';

export const APP_NAME = 'AntigravityBox';

/** Our own state dir: %APPDATA%\AntigravityBox (counterpart of ~/Library/Application Support/GravityBox). */
export function stateDir(): string {
  return process.env.ANTIGRAVITYBOX_STATE_DIR_OVERRIDE
    || process.env.AGRAVITYBOX_STATE_DIR_OVERRIDE /* 兼容历史拼写 */
    || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), APP_NAME);
}

/** Our own cache dir: %LOCALAPPDATA%\AntigravityBox. */
export function cacheDir(): string {
  return process.env.ANTIGRAVITYBOX_CACHE_DIR_OVERRIDE
    || process.env.AGRAVITYBOX_CACHE_DIR_OVERRIDE /* 兼容历史拼写 */
    || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), APP_NAME);
}

/** Read-only conversation databases root (identical layout to macOS). */
export function defaultGeminiDir(): string {
  return process.env.ANTIGRAVITYBOX_GEMINI_DIR_OVERRIDE || join(homedir(), '.gemini');
}

/**
 * Windows replacement for the POSIX `uid` check used across gravitybox file handling:
 * on Windows we only require a regular, non-symlink file owned by whoever we run as
 * (NTFS ACLs under the user profile provide the isolation POSIX 0600 did).
 */
export function isRegularUserFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink();
}

/** Best-effort language tag for the active user culture on Windows. */
export async function systemLocale(): Promise<string | undefined> {
  const env = process.env;
  for (const candidate of [env.ANTIGRAVITYBOX_LOCALE_OVERRIDE, env.LC_ALL, env.LANG]) {
    if (candidate) return candidate.split('.')[0];
  }
  try {
    const { requirePowerShell } = await import('./shell.js');
    const out = (await requirePowerShell('(Get-Culture).Name', { timeoutMs: 4_000 })).trim();
    if (out) return out;
  } catch { /* fall through to Intl */ }
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || undefined;
  } catch {
    return undefined;
  }
}
