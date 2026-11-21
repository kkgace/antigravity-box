// AntigravityBox — conversation browser contracts (file discovery + ledger aggregation + path guard).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageStatsManager } from '../dist/core/usage.js';

const mkRoot = () => mkdtempSync(join(tmpdir(), 'agbox-conv-'));

function seedGeminiDir(root) {
  const convDir = join(root, 'antigravity', 'conversations');
  mkdirSync(convDir, { recursive: true });
  // 两个会话库 + 噪声文件(wal/shm 必须被过滤)
  writeFileSync(join(convDir, 'abc-123.db'), Buffer.alloc(2048));
  writeFileSync(join(convDir, 'abc-123.db-wal'), Buffer.alloc(64));
  writeFileSync(join(convDir, 'abc-123.db-shm'), Buffer.alloc(32));
  writeFileSync(join(convDir, 'def-456.db'), Buffer.alloc(4096));
  writeFileSync(join(convDir, 'notes.txt'), 'noise');
  // mtime 排序:def-456 更新
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(convDir, 'abc-123.db'), old, old);
  return convDir;
}

test('conversationOverview: lists only .db files with zeroed stats when ledger is empty', async () => {
  const root = mkRoot();
  try {
    seedGeminiDir(root);
    const mgr = new UsageStatsManager({ stateDir: join(root, 'state'), geminiDir: root, dataDirectoryName: 'antigravity' });
    const { conversations } = await mgr.conversationOverview();
    assert.equal(conversations.length, 2);
    const names = conversations.map(c => c.file).sort();
    assert.deepEqual(names, ['abc-123.db', 'def-456.db']);
    for (const c of conversations) {
      assert.equal(c.requests, 0);
      assert.equal(c.tokens, 0);
      assert.equal(c.models, 0);
    }
    // mtime 降序:def-456 在前
    assert.equal(conversations[0].file, 'def-456.db');
    assert.equal(conversations[0].sizeBytes, 4096);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('conversationEvents: rejects traversal and non-file arguments', async () => {
  const root = mkRoot();
  try {
    const mgr = new UsageStatsManager({ stateDir: join(root, 'state'), geminiDir: root, dataDirectoryName: 'antigravity' });
    await assert.rejects(() => mgr.conversationEvents('../escape.db'), /invalid conversation file/);
    await assert.rejects(() => mgr.conversationEvents('a\\b.db'), /invalid conversation file/);
    await assert.rejects(() => mgr.conversationEvents(''), /invalid conversation file/);
    // 合法参数但账本为空 → 空数组而非抛错
    assert.deepEqual(await mgr.conversationEvents('abc-123.db'), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
