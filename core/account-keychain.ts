// Ported from Enzoo404/gravitybox (MIT License) v1.1.2 — https://github.com/Enzoo404/gravitybox
// Windows adaptation: AntigravityBox project.
// The "keychain" abstraction is preserved so upstream logic is unchanged; on Windows the
// backing store is the Credential Manager entry go-keyring writes for the language server.
import { WindowsCredentialAdapter, type KeychainAdapter } from '../windows/keyring.js';

export type { KeychainAdapter } from '../windows/keyring.js';

/** Kept name for upstream compatibility; backed by Windows Credential Manager (advapi32 via PowerShell). */
export class SystemKeychainAdapter implements KeychainAdapter {
  private readonly inner = new WindowsCredentialAdapter();
  readPassword(service: string, account: string) { return this.inner.readPassword(service, account); }
  writePassword(service: string, account: string, password: string) { return this.inner.writePassword(service, account, password); }
  deletePassword(service: string, account: string) { return this.inner.deletePassword(service, account); }
}

export class MockKeychainAdapter implements KeychainAdapter {
  private store = new Map<string, string>();

  async readPassword(service: string, account: string): Promise<string | null> {
    return this.store.get(`${service}:${account}`) ?? null;
  }

  async writePassword(service: string, account: string, password: string): Promise<void> {
    this.store.set(`${service}:${account}`, password);
  }

  async deletePassword(service: string, account: string): Promise<void> {
    this.store.delete(`${service}:${account}`);
  }
}

export interface KeychainSyncAccount {
  email: string;
  token: {
    access_token: string;
    token_type?: string;
    refresh_token: string;
    expiry_timestamp: number;
    expires_in?: number;
    project_id?: string | null;
    is_gcp_tos?: boolean;
    id_token?: string | null;
  };
}

/**
 * 将指定账号写入系统凭据存储 (gemini/antigravity) 免密持久化
 */
export async function syncAccountToKeychain(
  acc: KeychainSyncAccount,
  keychain: KeychainAdapter = new SystemKeychainAdapter()
): Promise<void> {
  // 官方 Go 端按 oauth2.Token 解析：缺少 `expiry` 会被视为永不过期，从而永不刷新（约 1 小时后 401 并跳登录页）。
  // 因此必须写入 RFC3339 `expiry`；旧字段保留供 AntigravityBox 自身读取与回滚。
  const expirySec = Number(acc.token.expiry_timestamp);
  const expiry = Number.isFinite(expirySec) && expirySec > 0 ? new Date(expirySec * 1000).toISOString() : undefined;
  const expiresIn = expirySec > 0 ? Math.max(0, Math.floor(expirySec - Date.now() / 1000)) : acc.token.expires_in;
  const payload = JSON.stringify({
    token: {
      access_token: acc.token.access_token,
      token_type: acc.token.token_type || 'Bearer',
      refresh_token: acc.token.refresh_token,
      expiry,
      expires_in: expiresIn,
      expiry_timestamp: acc.token.expiry_timestamp,
      email: acc.email,
      project_id: acc.token.project_id,
      is_gcp_tos: acc.token.is_gcp_tos,
      id_token: acc.token.id_token,
    },
    ...(acc.token.is_gcp_tos ? {} : { auth_method: 'consumer' }),
    id_token_email: acc.email,
  });
  if (process.platform === 'win32') {
    // Windows 官方 Go 客户端通过 wincred 存储裸 JSON（本机实测）；写入同构，保证 language_server 可解析。
    await keychain.writePassword('gemini', 'antigravity', payload);
  } else {
    const b64 = Buffer.from(payload, 'utf8').toString('base64');
    await keychain.writePassword('gemini', 'antigravity', `go-keyring-base64:${b64}`);
  }
}
