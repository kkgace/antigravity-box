/**
 * AntigravityBox — Windows PowerShell execution helper.
 * Runs short PowerShell snippets with timeouts and output caps.
 * Scripts are passed via -EncodedCommand (UTF-16LE base64) to avoid quoting issues;
 * secrets always travel over stdin, never argv.
 */
import { spawn } from 'node:child_process';

const OUTPUT_CAP = 4_000_000;

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function encodeScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Run powershell.exe with a script; resolves on clean exit, rejects on timeout/spawn failure. */
export function runPowerShell(script: string, options?: { timeoutMs?: number; stdin?: string | Buffer; env?: Record<string, string | undefined> }): Promise<ShellResult> {
  const timeoutMs = options?.timeoutMs ?? 8_000;
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', encodeScript(script)],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: options?.env ? { ...process.env, ...options.env } : process.env },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(() => reject(new Error(`powershell timeout after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString('utf8');
    });
    child.stdin.on('error', () => { /* EPIPE when the process exits early; handled via close */ });
    if (options?.stdin !== undefined) child.stdin.write(options.stdin);
    child.stdin.end();
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => resolve({ code: code ?? -1, stdout, stderr })));
  });
}

/** Like runPowerShell but treats non-zero exit as a rejection with stderr text. */
export async function requirePowerShell(script: string, options?: { timeoutMs?: number; stdin?: string | Buffer }): Promise<string> {
  const result = await runPowerShell(script, options);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `powershell exit ${result.code}`);
  return result.stdout;
}
