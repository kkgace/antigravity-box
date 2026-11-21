// AntigravityBox test runner: node:test suite under test/.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = spawnSync(process.execPath, [join(root, 'tools', 'build.mjs')], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const testDir = join(root, 'test');
const files = readdirSync(testDir).filter(f => f.endsWith('.test.mjs') || f.endsWith('.test.js'));
const result = spawnSync(process.execPath, ['--test', ...files.map(f => join(testDir, f))], {
  cwd: root, stdio: 'inherit',
});
process.exit(result.status ?? 1);
