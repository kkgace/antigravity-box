// Static consistency checks for the AntigravityBox renderer (dev tooling, not shipped).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

const app = read('renderer/app.js');
const tray = read('renderer/tray.js');
const i18n = read('renderer/i18n.js');
const indexHtml = read('renderer/index.html');
const trayHtml = read('renderer/tray.html');
const router = read('electron/ipc-router.ts');

let problems = 0;
const fail = msg => { problems++; console.log('FAIL:', msg); };

// 1) invoke() commands must exist in the router
const handlerNames = [...router.matchAll(/^\s{4}([a-z_]+):\s*async/gm)].map(m => m[1]);
for (const [file, src] of [['app.js', app], ['tray.js', tray]]) {
  for (const m of src.matchAll(/invoke\('([a-z_]+)'/g)) {
    if (!handlerNames.includes(m[1])) fail(`${file} invokes unknown command "${m[1]}"`);
  }
}

// 2) el('id') targets must exist in the corresponding HTML the file generates
for (const [file, src, htmls] of [['app.js', app, [indexHtml]], ['tray.js', tray, [trayHtml]]]) {
  const ids = new Set([...src.matchAll(/el\('([a-zA-Z-]+)'\)/g)].map(m => m[1]));
  for (const html of htmls) for (const m of html.matchAll(/id="([a-zA-Z-]+)"/g)) ids.delete(m[1]);
  // ids rendered inside template literals: search the raw source for id="..."
  for (const m of src.matchAll(/id="([a-zA-Z-]+)"/g)) ids.delete(m[1]);
  // ids assigned programmatically via .id = '...'
  for (const m of src.matchAll(/\.id = '([a-zA-Z-]+)'/g)) ids.delete(m[1]);
  // id={...} dynamic ids excluded; report leftovers
  for (const id of ids) if (!id.includes('${')) fail(`${file} references unknown element id "${id}"`);
}

// 3) t('key') keys with English entries — report coverage (fallback to zh is allowed, warn only)
const enSection = i18n.slice(i18n.indexOf('const en = {'));
const enKeys = new Set([...enSection.matchAll(/^  '(.+?)':/gm)].map(m => m[1].replace(/\\n/g, '\n')));
const used = new Set();
for (const src of [app, tray]) for (const m of src.matchAll(/\bt\('((?:[^'\\]|\\.)+?)'/g)) used.add(m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n'));
let missing = 0;
for (const key of used) if (!enKeys.has(key) && !key.includes('${') && !key.startsWith('AntigravityBox')) missing++;
console.log(`i18n: ${used.size} keys used, ${missing} missing from en table (fallback to zh)`);
if (missing > 0) for (const key of used) if (!enKeys.has(key) && !key.includes('${') && !key.startsWith('AntigravityBox')) console.log('  missing en:', JSON.stringify(key));

// 4) preload surface used by renderer must exist in preload.cjs
const preload = read('electron/preload.cjs');
for (const [file, src] of [['app.js', app], ['tray.js', tray]]) {
  for (const m of src.matchAll(/window\.agbox\.([a-zA-Z]+)/g)) {
    if (!preload.includes(m[1])) fail(`${file} uses window.agbox.${m[1]} missing from preload`);
  }
}

console.log(problems === 0 ? 'ALL CHECKS PASSED' : `${problems} problem(s)`);
process.exit(problems === 0 ? 0 : 1);
