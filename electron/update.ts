/**
 * AntigravityBox — update checker (counterpart of gravitybox's AppUpdateManager).
 * Checks a GitHub repo's latest release, downloads the NSIS installer + .sha256
 * sidecar, verifies the SHA-256 digest, then hands off to the user for install.
 * Auto-check is off by default; nothing is downloaded or run without the user.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { get } from 'node:http';
import { spawn } from 'node:child_process';
import { app } from 'electron';

const GITHUB_API = 'https://api.github.com/repos';
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export interface UpdateCheckResult {
  status: 'up-to-date' | 'available' | 'no-repo' | 'no-asset' | 'error';
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  publishedAt?: string;
  assetName?: string;
  notes?: string;
}

function compareVersions(a: string, b: string): number {
  const pa = String(a).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = get(url, {
      headers: { 'User-Agent': 'AntigravityBox-Update', 'Accept': 'application/vnd.github+json' },
      timeout: 15000,
    }, res => {
      if ((res.statusCode ?? 500) >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function downloadTo(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const req = get(url, { headers: { 'User-Agent': 'AntigravityBox-Update' }, timeout: 60000 }, res => {
      // GitHub asset downloads redirect to a CDN; follow one hop.
      if ((res.statusCode ?? 500) >= 300 && res.headers.location) {
        res.resume();
        file.close(() => rm(dest, { force: true }).catch(() => {}));
        downloadTo(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if ((res.statusCode ?? 500) >= 300) {
        res.resume();
        file.close(() => rm(dest, { force: true }).catch(() => {}));
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', error => {
      file.close(() => rm(dest, { force: true }).catch(() => {}));
      reject(error);
    });
  });
}

async function sha256OfFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function parseExpectedDigest(text: string): string | null {
  // Sidecar formats: "<hex>" or "<hex>  <filename>" (shasum -a 256 -c style).
  const match = String(text).match(/\b([a-fA-F0-9]{64})\b/);
  return match ? match[1]!.toLowerCase() : null;
}

let lastCheck: { at: number; result: UpdateCheckResult } | null = null;
let pendingInstaller: string | null = null;

export async function checkForUpdate(repo: string, currentVersion: string, force = false): Promise<UpdateCheckResult> {
  const trimmedRepo = String(repo ?? '').trim();
  const current = String(currentVersion ?? '').trim();
  if (!trimmedRepo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmedRepo)) {
    return { status: 'no-repo', currentVersion: current,
      notes: '未配置更新源。在设置中把 updateRepo 配置为 GitHub 仓库(如 owner/repo)后即可检查更新。' };
  }
  if (!force && lastCheck && Date.now() - lastCheck.at < 10 * 60 * 1000) return lastCheck.result;
  try {
    const release = await fetchJson(`${GITHUB_API}/${trimmedRepo}/releases/latest`);
    const latestVersion = String(release?.tag_name ?? '').trim();
    const asset = (Array.isArray(release?.assets) ? release.assets : []).find((a: any) =>
      typeof a?.name === 'string' && /^AntigravityBox-Setup-.*-x64\.exe$/i.test(a.name));
    const shaAsset = (Array.isArray(release?.assets) ? release.assets : []).find((a: any) =>
      typeof a?.name === 'string' && /^AntigravityBox-Setup-.*-x64\.exe\.sha256$/i.test(a.name));
    const result: UpdateCheckResult = {
      status: latestVersion && asset && compareVersions(current || '0.0.0', latestVersion) < 0 ? 'available' : 'up-to-date',
      currentVersion: current,
      latestVersion,
      releaseUrl: release?.html_url,
      publishedAt: release?.published_at,
      assetName: asset?.name,
    };
    if (latestVersion && !asset) {
      result.status = 'no-asset';
      result.notes = '最新 Release 中没有找到 Windows 安装包(AntigravityBox-Setup-*-x64.exe)。';
    }
    lastCheck = { at: Date.now(), result };
    if (result.status === 'available') {
      result.notes = asset && shaAsset
        ? `发现新版本 ${latestVersion},可在本页下载并校验后安装。`
        : `发现新版本 ${latestVersion},请前往 Release 页面手动下载。`;
    }
    return result;
  } catch (error) {
    return { status: 'error', currentVersion: current,
      notes: `检查更新失败:${error instanceof Error ? error.message : String(error)}` };
  }
}

export interface DownloadedUpdate {
  ok: boolean;
  installerPath?: string;
  sha256?: string;
  error?: string;
}

/** Download the installer + sidecar, verify the digest; keeps everything in a temp dir until installed. */
export async function downloadAndVerifyUpdate(repo: string): Promise<DownloadedUpdate> {
  try {
    const check = await checkForUpdate(repo, app.getVersion(), true);
    if (check.status !== 'available' || !check.assetName) return { ok: false, error: check.notes ?? '当前已是最新版本' };
    const baseName = check.assetName;
    const dir = join(tmpdir(), 'AntigravityBox-update');
    mkdirSync(dir, { recursive: true });
    const installerPath = join(dir, baseName);
    const shaPath = `${installerPath}.sha256`;
    const release = await fetchJson(`${GITHUB_API}/${repo}/releases/latest`);
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const asset = assets.find((a: any) => a?.name === baseName);
    const shaAsset = assets.find((a: any) => a?.name === `${baseName}.sha256`);
    if (!asset?.browser_download_url) return { ok: false, error: '未找到安装包下载地址' };
    if (!shaAsset?.browser_download_url) return { ok: false, error: '未找到 SHA-256 校验文件(拒绝安装未校验的更新)' };
    await downloadTo(asset.browser_download_url, installerPath);
    await downloadTo(shaAsset.browser_download_url, shaPath);
    const expected = parseExpectedDigest(await readFile(shaPath, 'utf8'));
    const actual = await sha256OfFile(installerPath);
    if (!expected || expected !== actual.toLowerCase()) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, error: 'SHA-256 校验失败 — 安装包与校验文件不匹配,已丢弃下载内容。' };
    }
    pendingInstaller = installerPath;
    return { ok: true, installerPath, sha256: actual };
  } catch (error) {
    return { ok: false, error: `下载更新失败:${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Launch the verified installer detached, then quit so NSIS can replace files. */
export async function installPendingUpdate(): Promise<{ ok: boolean; error?: string }> {
  if (!pendingInstaller || !existsSync(pendingInstaller)) return { ok: false, error: '没有已校验待安装的更新,请先检查并下载更新。' };
  const installer = pendingInstaller;
  try {
    const child = spawn(installer, ['/SILENT'], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => app.quit(), 500);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `无法启动安装程序:${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Auto-check timer hook (24h cadence, opt-in). Returns the check result for the About badge. */
export async function autoCheckIfDue(repo: string, currentVersion: string, enabled: boolean): Promise<UpdateCheckResult | null> {
  if (!enabled) return null;
  return checkForUpdate(repo, currentVersion);
}

export const UPDATE_DOWNLOAD_TIMEOUT_MS = DOWNLOAD_TIMEOUT_MS;
