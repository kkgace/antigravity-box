/**
 * AntigravityBox — Recycle Bin delivery via Shell.Application.
 * Counterpart of macOS `.Trash` moves in gravitybox maintenance:
 * items are first copied to our snapshot dir (restore manifest), then moved
 * to the Windows Recycle Bin so nothing is ever hard-deleted.
 */
import { requirePowerShell, runPowerShell } from './shell.js';

/** Move a file or directory into the Recycle Bin (not a hard delete). */
export async function moveToRecycleBin(path: string): Promise<boolean> {
  // Shell.Application COM needs the literal path; pass it over stdin to survive quoting.
  const body = `
$ErrorActionPreference='Stop'
$src = [Console]::In.ReadLine()
if (-not (Test-Path -LiteralPath $src)) { [Console]::Out.Write('MISSING'); exit 0 }
$shell = New-Object -ComObject Shell.Application
$bin = $shell.Namespace(10)
if (-not $bin) { [Console]::Out.Write('NO_BIN'); exit 0 }
$bin.MoveHere($src, 4 + 16 + 512)
[Console]::Out.Write('OK')
`.trimStart();
  const result = await runPowerShell(body, { timeoutMs: 15_000, stdin: path });
  const out = result.stdout.trim();
  if (out === 'OK') return true;
  if (out === 'MISSING') return false;
  throw new Error(out || result.stderr.trim() || 'recycle bin move failed');
}

/** Item paths currently visible in the Recycle Bin (for diagnostics). */
export async function recycleBinPaths(limit = 50): Promise<string[]> {
  const script = `
$ErrorActionPreference='SilentlyContinue'
$shell = New-Object -ComObject Shell.Application
$bin = $shell.Namespace(10)
if ($bin) {
  $n = 0
  foreach ($item in $bin.Items()) {
    if ($n -ge ${limit}) { break }
    $orig = $bin.GetDetailsOf($item, 1)
    [Console]::Out.Write("ITEM=$orig\`n")
    $n++
  }
}
`.trim();
  const stdout = await requirePowerShell(script, { timeoutMs: 10_000 });
  const items: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('ITEM=')) items.push(line.slice(5).trim());
  }
  return items;
}
