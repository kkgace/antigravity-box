// AntigravityBox — quota history snapshots (JSONL append-only store).
// 每次配额刷新后落一行快照,供总览页 24h/7d 余量曲线使用。
// 零依赖、可单测:文件操作集中在 stateDir 下,坏行跳过不致命。
import { readFile, appendFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const QUOTA_HISTORY_FILE = 'quota-history.jsonl';

export interface QuotaHistoryAccountPoint {
  id: string;
  email: string;
  fiveHour: number | null;
  weekly: number | null;
}

export interface QuotaHistoryPoint {
  ts: number; // 秒级时间戳
  accounts: QuotaHistoryAccountPoint[];
}

const RETAIN_DAYS = 30;
const COMPACT_THRESHOLD = 6000; // 行数超过后压缩到 KEEP_LINES
const KEEP_LINES = 3000;

function sanitizeAccount(a: unknown): QuotaHistoryAccountPoint | null {
  const rec = a as Record<string, unknown> | null;
  if (!rec || typeof rec.id !== 'string' || typeof rec.email !== 'string') return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  return {
    id: rec.id.slice(0, 128),
    email: rec.email.slice(0, 200),
    fiveHour: num(rec.fiveHour ?? rec.fiveHourRemaining),
    weekly: num(rec.weekly ?? rec.weeklyRemaining),
  };
}

/** 追加一条快照(失败静默:历史曲线是锦上添花,不应打断配额刷新)。 */
export async function appendQuotaSnapshot(
  stateDir: string,
  accounts: Array<{ id: string; email: string; fiveHourRemaining?: unknown; weeklyRemaining?: unknown }>,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ ok: boolean }> {
  try {
    const point: QuotaHistoryPoint = {
      ts: nowSec,
      accounts: accounts.map(sanitizeAccount).filter((a): a is QuotaHistoryAccountPoint => a !== null),
    };
    if (!point.accounts.length) return { ok: false };
    await mkdir(stateDir, { recursive: true });
    const file = join(stateDir, QUOTA_HISTORY_FILE);
    await appendFile(file, JSON.stringify(point) + '\n', 'utf8');
    await pruneIfNeeded(stateDir, nowSec);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

async function pruneIfNeeded(stateDir: string, nowSec: number): Promise<void> {
  const file = join(stateDir, QUOTA_HISTORY_FILE);
  const raw = await readFile(file, 'utf8').catch(() => '');
  const lines = raw ? raw.split('\n') : [];
  if (lines.length <= COMPACT_THRESHOLD) return;
  const keep = lines.slice(-KEEP_LINES);
  await writeFile(file, keep.join('\n'), 'utf8').catch(() => { /* 压缩失败保留现状 */ });
  void nowSec;
}

/** 解析并过滤历史点(坏行跳过;超过保留期的丢弃)。 */
export function parseQuotaHistory(raw: string, sinceTs: number): QuotaHistoryPoint[] {
  const points: QuotaHistoryPoint[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const ts = Number(parsed.ts);
      if (!Number.isFinite(ts) || ts < sinceTs) continue;
      const accounts = Array.isArray(parsed.accounts)
        ? parsed.accounts.map(sanitizeAccount).filter((a): a is QuotaHistoryAccountPoint => a !== null)
        : [];
      points.push({ ts, accounts });
    } catch { /* 跳过坏行 */ }
  }
  return points;
}

/**
 * 读取时间范围内的历史,并按 email 归并成曲线序列。
 * 每个(账号, 指标)最多保留 maxPoints 个采样点(均匀抽稀,保首尾)。
 */
export function readQuotaHistory(
  stateDir: string,
  hours: number,
  maxPoints = 120,
  readFileFn: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ points: QuotaHistoryPoint[]; emails: string[] }> {
  const sinceTs = nowSec - Math.max(1, Math.min(24 * 30, hours)) * 3600;
  return readFileFn(join(stateDir, QUOTA_HISTORY_FILE)).then(
    (raw) => {
      let points = parseQuotaHistory(raw, sinceTs);
      points.sort((a, b) => a.ts - b.ts);
      if (points.length > maxPoints) {
        const step = (points.length - 1) / (maxPoints - 1);
        const sampled: QuotaHistoryPoint[] = [];
        for (let i = 0; i < maxPoints; i++) sampled.push(points[Math.round(i * step)]!);
        points = sampled;
      }
      const emails = new Set<string>();
      for (const p of points) for (const a of p.accounts) emails.add(a.email);
      return { points, emails: [...emails] };
    },
    () => ({ points: [], emails: [] }),
  );
}
