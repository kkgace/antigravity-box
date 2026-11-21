// AntigravityBox — quota-history snapshot store contracts (JSONL append + parse + downsample).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendQuotaSnapshot,
  parseQuotaHistory,
  readQuotaHistory,
} from '../dist/core/quota-history.js';

const mkDir = () => mkdtempSync(join(tmpdir(), 'agbox-qh-'));

test('quota-history: append + parse round-trip keeps only in-range valid points', async () => {
  const dir = mkDir();
  try {
    const r1 = await appendQuotaSnapshot(dir, [
      { id: 'a1', email: 'one@test', fiveHourRemaining: 91.24, weeklyRemaining: 60 },
      { id: 'a2', email: 'two@test', fiveHourRemaining: 10.5 }, // weekly 缺失 → null
      { bad: true }, // 会被 sanitize 丢弃
      null,
    ], 1_800_000_000);
    assert.equal(r1.ok, true);
    const raw = await import('node:fs/promises').then(m => m.readFile(join(dir, 'quota-history.jsonl'), 'utf8'));
    const points = parseQuotaHistory(raw, 0);
    assert.equal(points.length, 1);
    assert.equal(points[0].accounts.length, 2);
    assert.equal(points[0].accounts[0].fiveHour, 91.2);
    assert.equal(points[0].accounts[1].weekly, null);
    // 范围过滤:早于 sinceTs 的点被丢弃
    assert.equal(parseQuotaHistory(raw, 1_800_000_001).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('quota-history: append rejects snapshots without valid accounts', async () => {
  const dir = mkDir();
  try {
    const r = await appendQuotaSnapshot(dir, [{ bad: true }]);
    assert.equal(r.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('quota-history: readQuotaHistory merges emails and downsamples to maxPoints keeping ends', async () => {
  const dir = mkDir();
  try {
    const now = 1_800_000_000;
    const lines = [];
    for (let i = 0; i < 300; i++) {
      lines.push(JSON.stringify({
        ts: now - 300 + i,
        accounts: [{ id: 'a1', email: 'one@test', fiveHour: i % 100, weekly: 50 }],
      }));
    }
    // 混入坏行与范围外点,都必须被跳过
    lines.push('not-json{');
    lines.push(JSON.stringify({ ts: now - 100000, accounts: [] }));
    writeFileSync(join(dir, 'quota-history.jsonl'), lines.join('\n') + '\n', 'utf8');
    const readFileFn = (p) => import('node:fs/promises').then(m => m.readFile(p, 'utf8'));
    const { points, emails } = await readQuotaHistory(dir, 24, 50, readFileFn, now);
    assert.equal(points.length, 50);
    assert.equal(points[0].ts, now - 300);       // 保首
    assert.equal(points[49].ts, now - 1);        // 保尾
    assert.deepEqual(emails, ['one@test']);
    // 时长裁剪:hours=1 只保留最近 1 小时
    const { points: short } = await readQuotaHistory(dir, 1, 120, readFileFn, now);
    assert.ok(short.every(p => p.ts >= now - 3600));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('quota-history: missing file yields empty history (not a rejection)', async () => {
  const dir = mkDir();
  try {
    const { points, emails } = await readQuotaHistory(dir, 24);
    assert.deepEqual(points, []);
    assert.deepEqual(emails, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
