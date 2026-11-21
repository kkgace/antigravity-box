// Ported from Enzoo404/gravitybox (MIT License) v1.1.2 — https://github.com/Enzoo404/gravitybox
// Windows adaptation: AntigravityBox project.
import { readFileSync } from 'node:fs';

// The packaged backend keeps this metadata in core/package.json, next to dist/.
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (typeof metadata.version !== 'string' || metadata.version !== metadata.version.trim() || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(metadata.version)) {
  throw new Error('缺少有效的构建版本（package.json 损坏或缺少 version 字段） / Missing valid build version');
}
export const APP_VERSION: string = metadata.version;
