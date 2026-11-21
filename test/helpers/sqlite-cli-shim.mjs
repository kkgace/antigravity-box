// AntigravityBox 测试辅助:sqlite3 CLI 兼容垫片。
// 上游测试 fixture 以 `execFileAsync('/usr/bin/sqlite3', [dbPath, sql])` 造库,
// Windows 无该 CLI;node:sqlite 的 db.exec 同样支持多语句脚本,语义一致。
// 非 sqlite3 调用透明回退真实 execFile,保持原签名 (file, args) => { stdout, stderr }。
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsyncNative = promisify(execFile);

export async function execFileAsync(file, args, options) {
  if (typeof file === 'string' && file.endsWith('sqlite3')) {
    const [dbPath, sql] = args;
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    return { stdout: '', stderr: '' };
  }
  return execFileAsyncNative(file, args, options);
}
