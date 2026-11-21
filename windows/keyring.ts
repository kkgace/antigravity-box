/**
 * AntigravityBox — Windows Credential Manager adapter (go-keyring compatible).
 * Antigravity's Go language server stores its OAuth token as a Windows generic
 * credential with target name `gemini:antigravity` and payload
 * `go-keyring-base64:<base64 JSON>` — the exact same shape gravitybox reads from
 * the macOS Keychain. We read/write the same entry via advapi32 CredRead/CredWrite
 * through PowerShell; secrets travel over stdin/base64, never argv.
 */
import { randomUUID } from 'node:crypto';
import { requirePowerShell, runPowerShell } from './shell.js';

const CRED_TYPE_GENERIC = 1;
const CRED_PERSIST_LOCAL_MACHINE = 2;

const PSCODE = `
param()
$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AgbCredMan {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credPtr);
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);

  public static string ReadB64(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return "";
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] blob = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, blob, 0, c.CredentialBlobSize);
      return Convert.ToBase64String(blob) + "|" + Convert.ToBase64String(Encoding.UTF8.GetBytes(c.UserName ?? ""));
    } finally { CredFree(p); }
  }
  public static bool WriteB64(string target, string userB64, string secretB64) {
    byte[] blob = Convert.FromBase64String(secretB64);
    string user = Encoding.UTF8.GetString(Convert.FromBase64String(userB64));
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = user;
    c.CredentialBlobSize = blob.Length; c.Persist = 2;
    IntPtr p = Marshal.AllocHGlobal(blob.Length);
    Marshal.Copy(blob, 0, p, blob.Length);
    c.CredentialBlob = p;
    try { return CredWrite(ref c, 0); } finally { Marshal.FreeHGlobal(p); }
  }
  public static bool DeleteTarget(string target) { return CredDelete(target, 1, 0); }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
$payload = [Console]::In.ReadToEnd()
$parts = $payload -split "\\n"
$action = $parts[0]
try {
  switch ($action) {
    "read" {
      $r = [AgbCredMan]::ReadB64($parts[1])
      [Console]::Out.Write("OK\`n" + $r)
    }
    "write" {
      $ok = [AgbCredMan]::WriteB64($parts[1], $parts[2], $parts[3])
      [Console]::Out.Write($(if ($ok) { "OK" } else { "FAIL" }))
    }
    "delete" {
      $ok = [AgbCredMan]::DeleteTarget($parts[1])
      [Console]::Out.Write($(if ($ok) { "OK" } else { "FAIL" }))
    }
    default { [Console]::Out.Write("BAD_ACTION") }
  }
} catch {
  [Console]::Out.Write("ERR")
}
`.trimStart();

export interface KeychainAdapter {
  readPassword(service: string, account: string): Promise<string | null>;
  writePassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<void>;
}

function targetName(service: string, account: string): string {
  // go-keyring/wincred convention observed on this machine: `LegacyGeneric:target=gemini:antigravity`.
  return `${service}:${account}`;
}

async function invoke(action: string[], timeoutMs = 8_000): Promise<string> {
  const stdin = action.join('\n');
  const result = await runPowerShell(PSCODE, { timeoutMs, stdin });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `credman exit ${result.code}`);
  return result.stdout;
}

/** Windows Credential Manager backed adapter compatible with gravitybox's KeychainAdapter interface. */
export class WindowsCredentialAdapter implements KeychainAdapter {
  async readPassword(service: string, account: string): Promise<string | null> {
    const out = await invoke(['read', targetName(service, account)]);
    const [status, payload] = out.split('\n');
    if (status !== 'OK' || !payload) return null;
    const [blobB64, userB64] = payload.split('|');
    if (!blobB64) return null;
    return Buffer.from(blobB64, 'base64').toString('utf8');
  }

  async writePassword(service: string, account: string, password: string): Promise<void> {
    const stdin = ['write', targetName(service, account),
      Buffer.from(account, 'utf8').toString('base64'),
      Buffer.from(password, 'utf8').toString('base64')].join('\n');
    const result = await runPowerShell(PSCODE, { timeoutMs: 8_000, stdin });
    if (result.stdout.trim() !== 'OK') throw new Error(result.stderr.trim() || 'credman write failed');
  }

  async deletePassword(service: string, account: string): Promise<void> {
    const out = await invoke(['delete', targetName(service, account)]);
    if (!out.includes('OK') && !out.includes('FAIL')) throw new Error('credman delete failed');
    // FAIL means the credential does not exist; deleting a missing credential is a no-op.
  }
}

/** One-off handshake probe used by doctor/verify: proves CredRead works without touching target data. */
export async function credentialManagerAvailable(): Promise<boolean> {
  const probeTarget = `antigravitybox-probe-${randomUUID()}`;
  try {
    await invoke(['write', probeTarget, Buffer.from('probe', 'utf8').toString('base64'),
      Buffer.from('ok', 'utf8').toString('base64')], 10_000);
    const out = await invoke(['read', probeTarget]);
    return out.includes('OK');
  } catch {
    return false;
  } finally {
    await invoke(['delete', probeTarget]).catch(() => undefined);
  }
}

export { requirePowerShell };
