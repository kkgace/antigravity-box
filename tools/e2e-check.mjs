// AntigravityBox E2E verification against the REAL local environment.
// Validates: credential manager read → account save → quota fetch → usage scan.
// Secrets are never printed; only emails, percentages and counts.
import { join } from 'node:path';
import { homedir } from 'node:os';

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// 1. Credential Manager (Windows keyring)
{
  const { WindowsCredentialAdapter } = await import('../dist/windows/keyring.js');
  const adapter = new WindowsCredentialAdapter();
  try {
    const password = await adapter.readPassword('gemini', 'antigravity');
    // Windows stores raw JSON; macOS stores the go-keyring-base64 prefixed form. Accept both.
    const raw = typeof password === 'string' && password.startsWith('go-keyring-base64:')
      ? Buffer.from(password.slice('go-keyring-base64:'.length), 'base64').toString('utf8')
      : (password ?? '');
    const hasPayload = raw.startsWith('{');
    let email = null, expirySec = 0, hasRefresh = false;
    if (hasPayload) {
      try {
        const parsed = JSON.parse(raw);
        email = parsed?.token?.email || parsed?.id_token_email || null;
        expirySec = Number(parsed?.token?.expiry_timestamp) || (Number.isFinite(Date.parse(parsed?.token?.expiry)) ? Math.floor(Date.parse(parsed.token.expiry) / 1000) : 0);
        hasRefresh = typeof parsed?.token?.refresh_token === 'string' && parsed.token.refresh_token.length > 0;
      } catch { /* parse failure reported below */ }
    }
    record('keyring.read', hasPayload, `payload=present email=${email ?? 'unknown'} expiresAt=${expirySec ? new Date(expirySec * 1000).toISOString() : '?'} refreshToken=${hasRefresh}`);
  } catch (error) {
    record('keyring.read', false, error.message);
  }
}

// 2. Backend: save current account + list + quota overview
let savedEmail = null;
{
  const { Backend } = await import('../dist/electron/backend.js');
  const backend = new Backend();
  try {
    const account = await backend.accountsManager.saveCurrentAccount();
    savedEmail = account.email;
    record('account.save_current', true, `id=${account.id} email=${account.email}`);
  } catch (error) {
    record('account.save_current', false, error.message);
  }
  try {
    const list = await backend.accountList();
    record('account.list', Array.isArray(list.accounts), `${list.accounts.length} account(s), active=${list.activeId ?? 'none'}, identity=${list.identityState}`);
    for (const a of list.accounts) {
      // fiveHour/weeklyRemaining 已是 0-100 整数(core/quota.ts pct())，直接取整。
      const fh = Number.isFinite(a.fiveHourRemaining) ? Math.round(a.fiveHourRemaining) + '%' : '—';
      const wk = Number.isFinite(a.weeklyRemaining) ? Math.round(a.weeklyRemaining) + '%' : '—';
      console.log(`      · ${a.email} tier=${a.subscription_tier ?? '?'} 5h=${fh} weekly=${wk}`);
    }
  } catch (error) {
    record('account.list', false, error.message);
  }
}

// 3. Live quota refresh via cloud endpoints (real token, real API)
{
  const { Backend } = await import('../dist/electron/backend.js');
  const backend = new Backend();
  try {
    const list = await backend.accountsManager.listAccounts();
    const targetId = list.accounts[0]?.id;
    if (!targetId) throw new Error('no saved account to refresh');
    const updated = await backend.accountsManager.refreshQuota(targetId);
    const groups = updated.quota?.quota_groups ?? [];
    const models = updated.quota?.models ?? [];
    const summary = groups.map(g => `${g.display_name || g.family}:[${(g.buckets ?? []).map(b => `${b.window}=${Math.round((b.remaining_fraction ?? 0) * 100)}%`).join(', ')}]`).join('  ');
    record('quota.refresh_cloud', (groups.length + models.length) > 0, `tier=${updated.quota?.subscription_tier ?? '?'} ${summary || `models=${models.length}`}`);
    if (!groups.length && models.length) {
      console.log('      · models:', models.slice(0, 6).map(m => `${m.name}=${Math.round((m.percentage ?? 0) * 100)}%`).join(', '));
    }
  } catch (error) {
    record('quota.refresh_cloud', false, error.message);
  }
}

// 4. Usage scan over real conversation databases
{
  const { Backend } = await import('../dist/electron/backend.js');
  const backend = new Backend();
  try {
    const t0 = Date.now();
    const summary = await backend.usageManager.getUsageSummary(true);
    const ms = Date.now() - t0;
    const today = summary.today ?? summary.all_time;
    record('usage.scan', !summary.has_error, `dbs=${summary.databases_scanned}/${summary.databases_discovered} in ${ms}ms todayTokens=${today?.totals?.total_tokens ?? 0} requests=${today?.totals?.request_count ?? 0} allUsd=${(summary.all_time?.estimated_usd ?? 0).toFixed(4)}`);
    const models = today?.by_model ?? [];
    if (models.length) console.log('      · top:', models.slice(0, 5).map(m => `${m.model}=${m.total_tokens}`).join(', '));
  } catch (error) {
    record('usage.scan', false, error.message);
  }
}

// 5. Discovery: Antigravity CDP (expected absent unless launched with debug port)
{
  const { discover, isApplicationRunning } = await import('../dist/core/discovery.js');
  const { applicationTarget } = await import('../dist/core/application-target.js');
  const target = applicationTarget();
  try {
    const running = await isApplicationRunning(target.appPath);
    const endpoint = await discover(target.appPath, target.profile);
    record('discovery.cdp', true, `appRunning=${running} endpoint=${endpoint ? `port=${endpoint.port} v=${endpoint.appVersion}` : 'none (expected unless launched with --remote-debugging-port)'}`);
  } catch (error) {
    record('discovery.cdp', false, error.message);
  }
}

// 6. Target probing (bundle capabilities)
{
  const { applicationTarget } = await import('../dist/core/application-target.js');
  const target = applicationTarget();
  record('target.probe', true, `appPath=${target.appPath} profile=${target.profile} arch=${target.architecture}`);
}

console.log('\n====', results.filter(r => r.ok).length, '/', results.length, 'passed ====');
process.exit(results.every(r => r.ok) ? 0 : 1);
