// AntigravityBox — personal dictionary layer contracts (read/write/normalize/validate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPersonalDictionary,
  writePersonalDictionary,
  normalizeDictionaryKey,
  personalDictionaryPath,
} from '../dist/core/dictionary.js';

const mkDir = () => mkdtempSync(join(tmpdir(), 'agbox-pd-'));

test('personal dictionary: missing file reads as empty object', async () => {
  const dir = mkDir();
  try {
    const entries = await readPersonalDictionary(dir);
    assert.equal(Object.keys(entries).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('personal dictionary: write normalizes keys, validates placeholders, and round-trips', async () => {
  const dir = mkDir();
  try {
    const { count } = await writePersonalDictionary(dir, {
      'Settings': '设置',
      '  Reset   Password ': '重置密码', // 多空格/大小写会被 normalizeText 归一
    });
    assert.equal(count, 2);
    const entries = await readPersonalDictionary(dir);
    assert.equal(entries['Settings'], '设置');
    // 键已归一(折叠连续空白,大小写保留),与三层词典加载语义一致
    assert.equal(entries['Reset Password'], '重置密码');
    // 路径确实是个人覆盖层文件
    assert.equal(personalDictionaryPath(dir).endsWith('个人覆盖.json'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('personal dictionary: placeholder mismatch and non-string values are rejected atomically', async () => {
  const dir = mkDir();
  try {
    mkdirSync(dir, { recursive: true });
    await writePersonalDictionary(dir, { 'Settings': '设置' });
    // 占位符不匹配 → 整表拒绝(坏键不落盘)
    await assert.rejects(() => writePersonalDictionary(dir, { 'Hi {{name}}': '你好' }));
    await assert.rejects(() => writePersonalDictionary(dir, { 'Ok': 42 }));
    // 原有内容未被破坏(validateEntries 返回 null-prototype 对象,按键值断言)
    const entries = await readPersonalDictionary(dir);
    assert.equal(Object.getPrototypeOf(entries), null);
    assert.equal(entries['Settings'], '设置');
    assert.equal(Object.keys(entries).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('personal dictionary: corrupt file read throws with a clear error', async () => {
  const dir = mkDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '个人覆盖.json'), 'not-json{', 'utf8');
    await assert.rejects(() => readPersonalDictionary(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('normalizeDictionaryKey collapses whitespace (case preserved, matching dictionary layering)', () => {
  assert.equal(normalizeDictionaryKey('  Open   the   Menu '), 'Open the Menu');
});
