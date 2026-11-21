// AntigravityBox — CSV export + monthly cost projection contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, usageEventsCsv, projectMonthlyCost } from '../dist/core/csv.js';

test('toCsv: quotes fields containing commas/quotes/newlines and doubles inner quotes', () => {
  const csv = toCsv(['a', 'b'], [
    ['plain', 'has,comma'],
    ['has"quote', 'multi\nline'],
  ]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'a,b');
  assert.equal(lines[1], 'plain,"has,comma"');
  assert.equal(lines[2], '"has""quote","multi\nline"');
  assert.ok(csv.endsWith('\r\n'));
});

test('toCsv: neutralizes spreadsheet formula injection on dangerous leading characters', () => {
  const csv = toCsv(['x'], [['=1+1'], ['+SUM(A1)'], ['-2'], ['@cmd']]);
  assert.ok(csv.includes('"=1+1"'));
  assert.ok(csv.includes('"+SUM(A1)"'));
  assert.ok(csv.includes('"-2"'));
  assert.ok(csv.includes('"@cmd"'));
});

test('usageEventsCsv: emits BOM, header row, and metric-only columns', () => {
  const csv = usageEventsCsv([
    { timestamp_seconds: 1_800_000_000, model: 'gemini-3-pro', input_tokens: 100, cached_tokens: 50,
      cache_write_tokens: 10, output_tokens: 20, total_tokens: 180, estimated_usd: 0.01, account_email: 'a@t' },
    { model: 'unpriced-model', priced: false },
  ]);
  assert.ok(csv.startsWith('\uFEFF'), 'Excel 需要 BOM 才能识别 UTF-8');
  const body = csv.slice(1);
  const lines = body.trimEnd().split('\r\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('时间') && lines[0].includes('费用估算USD') && lines[0].includes('已计价'));
  assert.ok(lines[1].includes('gemini-3-pro'));
  assert.ok(lines[2].includes('unpriced-model'));
  assert.ok(lines[2].endsWith(',0'), 'priced=false → 已计价列写 0');
});

test('projectMonthlyCost: linear extrapolation from 7d, guard against missing data', () => {
  assert.equal(projectMonthlyCost(7), 30);           // 7 USD/7d → 30 USD/30d
  assert.equal(projectMonthlyCost(3.5), 15);          // 含两位小数取整
  assert.equal(projectMonthlyCost(0), null);          // 无消费不外推
  assert.equal(projectMonthlyCost(undefined), null);
  assert.equal(projectMonthlyCost(NaN), null);
  assert.equal(projectMonthlyCost(14, 7, 15), 30);    // 自定义周期
});
