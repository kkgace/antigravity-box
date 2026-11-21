// AntigravityBox afterPack: strip runtime dead weight from the packed app before NSIS compression.
// 只删「运行时确认不需要」的文件;GPU 渲染链(dxcompiler 之外的 ANGLE/SwiftShader/D3D compiler)全部保留,
// 保证无 GPU/远程桌面环境下仍有软件渲染回退。
// 注意:electron-builder 对 .cjs 钩子按 CommonJS require 加载,必须用 require/module.exports,不能用 ESM import。
const { unlinkSync, existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

module.exports = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const removed = [];

  // 1) dxcompiler.dll(~25MB):WebGPU(Dawn)按需加载的 DXIL 编译器。
  //    本应用渲染层是纯 DOM/CSS,不使用 WebGPU;缺失时 Chromium 仅使 WebGPU 不可用,不影响页面渲染。
  const dxcompiler = join(appOutDir, 'dxcompiler.dll');
  if (existsSync(dxcompiler)) {
    unlinkSync(dxcompiler);
    removed.push('dxcompiler.dll');
  }

  // 2) 双保险:electronLanguages 已声明只保留中英 locale;此处幂等清扫,防配置在个别版本未生效。
  const localesDir = join(appOutDir, 'locales');
  if (existsSync(localesDir)) {
    const keep = new Set(['zh-CN.pak', 'en-US.pak']);
    for (const name of readdirSync(localesDir)) {
      if (name.endsWith('.pak') && !keep.has(name)) {
        try {
          unlinkSync(join(localesDir, name));
          removed.push(`locales/${name}`);
        } catch { /* 清理失败不阻塞打包 */ }
      }
    }
  }

  if (removed.length > 0) {
    console.log(`[afterPack] removed ${removed.length} runtime-unused files (${removed.slice(0, 3).join(', ')}${removed.length > 3 ? ` … +${removed.length - 3}` : ''})`);
  }
};
