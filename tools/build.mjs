// AntigravityBox build: tsc compile + static assets staging.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const dist = join(root, 'dist');

const tsc = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc')], {
  cwd: root, stdio: 'inherit',
});
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

// Runtime injection scripts (CDP) and renderer stay as static files next to dist.
// ui-strings/ 不进 dist:那是开发期界面快照门禁工具(coverage-report/extract-ui-strings)的输入,
// 运行时没有任何模块读取它 —— 打进安装包纯属浪费(~5MB)。
mkdirSync(dist, { recursive: true });
cpSync(join(root, 'package.json'), join(dist, 'package.json'));
// 清理历史构建残留的 ui-strings(见上),防止旧产物把 5MB 开发期数据带进安装包。
rmSync(join(dist, 'ui-strings'), { recursive: true, force: true });
for (const dir of ['runtime', 'dict', 'assets', 'renderer']) {
  const src = join(root, dir);
  const dest = join(dist, dir);
  if (existsSync(src)) {
    cpSync(src, dest, { recursive: true });
    console.log(`staged ${dir}/ -> dist/${dir}/`);
  }
}
// preload 是 CommonJS 静态文件,tsc 不会搬运;主进程从 dist/electron/preload.cjs 加载。
{
  const src = join(root, 'electron', 'preload.cjs');
  const dest = join(dist, 'electron', 'preload.cjs');
  mkdirSync(join(dist, 'electron'), { recursive: true });
  cpSync(src, dest);
  console.log('staged electron/preload.cjs -> dist/electron/preload.cjs');
}
// 生成 CDP 注入包 dist/core/engine.js(controller.ts start() 从 ./engine.js 读取)。
const { copyRuntime } = await import('./copy-runtime.mjs');
await copyRuntime(join(dist, 'core'));
console.log('generated dist/core/engine.js');
console.log('build complete');
