# Third-party notices

## Enzoo404/gravitybox (upstream project)

AntigravityBox 是 [Enzoo404/gravitybox](https://github.com/Enzoo404/gravitybox) 的 Windows 移植版。
核心 TypeScript 源码、词典数据、HUD 运行时与测试套件移植自上游 v1.1.2,并按上游 MIT 许可证的
要求保留本归属声明。

MIT License

Copyright (c) Enzoo404 / gravitybox contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## 移植差异说明

- 运行环境:macOS (Swift/AppKit + Unix Domain Socket) → Windows (Electron 37 + IPC)
- 进程发现:`/bin/lsof`/`/bin/ps` → PowerShell `Get-NetTCPConnection`/`Get-CimInstance Win32_Process`
- 凭据存储:macOS Keychain(`go-keyring-base64:` 前缀) → Windows 凭据管理器(裸 JSON,与官方
  language_server 读取格式一致)
- SQLite 访问:上游 sqlite3 CLI 依赖 → Node.js 内置 `node:sqlite`
- 回收站:`~/.Trash`(TCC) → Windows 回收站(Shell.Application)+ 本地安全回收仓回退
- HUD/翻译注入:上游零修改 CDP 协议原样保留(Chrome DevTools Protocol, Isolated World)

本仓库其余代码以 MIT 许可发布(见 LICENSE)。
