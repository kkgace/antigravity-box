// AntigravityBox — 将 renderer/icon.png(PNG 256x256)封装为 ICO。
// Vista+ 支持 PNG 压缩的 ICO 条目,无需重采样;NSIS/任务栏/快捷方式均可用。
import { readFile, writeFile } from 'node:fs/promises';

const png = await readFile(new URL('../renderer/icon.png', import.meta.url));
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
// ICO 目录宽度字段为 1 字节;256px 按惯例编码为 0。仅支持 ≤256 的方形 PNG。
if (width !== height || width > 256 || width < 1) throw new Error(`需方形 1–256px PNG,实际 ${width}x${height}`);

// ICO 结构:6B 头 + 16B 目录 + 图像数据
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);      // reserved
header.writeUInt16LE(1, 2);      // type: icon
header.writeUInt16LE(1, 4);      // count

const entry = Buffer.alloc(16);
entry.writeUInt8(width === 256 ? 0 : width, 0);   // 宽(0 = 256)
entry.writeUInt8(height === 256 ? 0 : height, 1); // 高
entry.writeUInt8(0, 2);          // 调色板数
entry.writeUInt8(0, 3);          // 保留
entry.writeUInt16LE(1, 4);       // 平面数
entry.writeUInt16LE(32, 6);      // 位深(PNG 条目仅供参考)
entry.writeUInt32LE(png.length, 8);  // 数据大小
entry.writeUInt32LE(22, 12);         // 数据偏移(6+16)

await writeFile(new URL('../renderer/icon.ico', import.meta.url), Buffer.concat([header, entry, png]));
console.log(`renderer/icon.ico written (${width}x${height}, ${png.length}B PNG-in-ICO)`);
