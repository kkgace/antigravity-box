// AntigravityBox — tray quick panel (配额 / 用量 / 账号 三页签 + ··· 快捷菜单).
import { invoke, fmtTokens, fmtUsd, fmtPct, barClass, tierBadge, escapeHtml } from './common.js';
import { t, setLanguage, getLanguage } from './i18n.js';

const el = id => document.getElementById(id);
let mode = 'quota';
let accounts = null;
let usage = null;
let config = null;
let trendMetric = 'tokens'; // 趋势柱状图维度:tokens | requests
let trayLang = 'zh-Hans';

function applyLang() {
  setLanguage(config?.language ?? 'system');
  trayLang = getLanguage();
  document.title = 'AntigravityBox ' + t('快捷面板');
  el('tab-quota').textContent = t('配额');
  el('tab-usage').textContent = t('用量');
  el('tab-accounts').textContent = t('账号');
  el('open-main').textContent = t('打开主界面 ↗');
  el('menu-open-main').textContent = t('打开主界面');
  el('menu-quit').textContent = t('退出');
  for (const btn of document.querySelectorAll('.menu-lang')) {
    const pref = btn.dataset.lang;
    btn.textContent = pref === 'system' ? t('跟随系统') : pref === 'zh-Hans' ? t('简体中文') : t('English');
    btn.classList.toggle('active', pref === (config?.language ?? 'system'));
  }
  const hudCheck = el('menu-hud');
  hudCheck.checked = config?.hudEnabled !== false;
  hudCheck.closest('.menu-row').querySelector('span').textContent = t('对话状态栏');
}

function quotaRows(account) {
  const groups = account?.quota?.quota_groups ?? [];
  if (!groups.length) return `<div class="empty">${t('暂无配额数据')}</div>`;
  return groups.map(g => (g.buckets ?? []).map(b => {
    const remaining = b.remaining_fraction;
    const pct = Number.isFinite(remaining) ? Math.round(remaining * 100) : null;
    const known = b.remaining_fraction_known !== false;
    return `
    <div class="tray-quota q-group">
      <div class="q-head"><span>${escapeHtml(g.display_name || g.family)} · ${b.window === '5h' ? (trayLang === 'en' ? '5h' : '5h') : (trayLang === 'en' ? 'Weekly' : '周')}</span><span>${pct === null ? '—' : fmtPct(remaining, known)}</span></div>
      <div class="bar"><div class="${barClass(remaining)}" style="width:${pct ?? 0}%"></div></div>
      ${b.reset_countdown ? `<div class="q-head"><span style="font-size:10px;color:var(--fg-faint)">${escapeHtml(b.reset_countdown)}${trayLang === 'en' ? ' to reset' : '后重置'}</span></div>` : ''}
    </div>`;
  }).join('')).join('');
}

function renderQuota() {
  const active = accounts?.accounts?.find(a => a.id === accounts.activeId) ?? accounts?.accounts?.[0];
  el('content').innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
      <span style="font-weight:600;font-size:13px">${escapeHtml(active?.email ?? t('未登录'))}</span>
      ${tierBadge(active?.subscription_tier)}
    </div>
    ${quotaRows(active)}`;
}

function trendBarsTray(trends) {
  const data = Array.isArray(trends) ? trends : [];
  if (!data.length) return `<div class="empty">${t('暂无数据')}</div>`;
  const key = trendMetric === 'tokens' ? 'total_tokens' : 'request_count';
  const max = Math.max(...data.map(d => Number(d?.[key] ?? 0)), 1);
  return `<div class="trend tray-trend">${data.map(d => {
    const v = Number(d?.[key] ?? 0);
    const day = d?.date ? String(d.date).slice(5) : '';
    return `<div class="tbar" style="height:${Math.max(2, Math.round(v / max * 64))}px" title="${day || ''} ${fmtTokens(v)}"></div>`;
  }).join('')}</div>`;
}

function renderUsage() {
  const today = usage?.today;
  const week = usage?.['7d'];
  const byModel = (today?.byModel ?? []).slice(0, 5);
  el('content').innerHTML = `
    <div class="grid" style="grid-template-columns:1fr 1fr;gap:8px;">
      <div class="card metric" style="margin:0;padding:10px 12px;"><div class="label">${t('今日 Token')}</div><div class="value" style="font-size:18px">${fmtTokens(today?.totals?.total_tokens)}</div></div>
      <div class="card metric" style="margin:0;padding:10px 12px;"><div class="label">${t('今日费用')}</div><div class="value" style="font-size:18px">${fmtUsd(today?.estimatedUsd)}</div></div>
      <div class="card metric" style="margin:0;padding:10px 12px;"><div class="label">${t('今日请求')}</div><div class="value" style="font-size:18px">${fmtTokens(today?.totals?.request_count)}</div></div>
      <div class="card metric" style="margin:0;padding:10px 12px;"><div class="label">${t('缓存命中')}</div><div class="value" style="font-size:18px">${today ? today.cacheHitRate + '%' : '—'}</div></div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:10px;">
      <span style="font-size:12px;color:var(--fg-muted)">${t('近 7 天')}</span>
      <div class="tabs" style="margin:0;">
        <button data-metric="tokens" class="${trendMetric === 'tokens' ? 'active' : ''}" style="padding:2px 10px;font-size:11px;">${t('Token')}</button>
        <button data-metric="requests" class="${trendMetric === 'requests' ? 'active' : ''}" style="padding:2px 10px;font-size:11px;">${t('请求')}</button>
      </div>
    </div>
    ${trendBarsTray(week?.dailyTrends)}
    <div style="font-size:12px;color:var(--fg-muted);margin:10px 0 4px;">${t('今日活跃模型')}</div>
    ${byModel.length ? `<table style="font-size:12px"><tbody>
      ${byModel.map(m => `<tr><td class="mono" style="padding:4px 6px">${escapeHtml(m.model)}</td><td style="padding:4px 6px">${fmtTokens(m.total_tokens)}</td><td style="padding:4px 6px">${fmtUsd(m.estimated_usd)}</td></tr>`).join('')}
    </tbody></table>` : `<div class="empty" style="padding:10px 0">${t('今日暂无调用')}</div>`}`;
  for (const btn of el('content').querySelectorAll('[data-metric]')) {
    btn.onclick = () => { trendMetric = btn.dataset.metric; renderUsage(); };
  }
}

function renderAccounts() {
  const list = accounts?.accounts ?? [];
  if (!list.length) return void (el('content').innerHTML = `<div class="empty">${t('暂无已保存账号')}</div>`);
  el('content').innerHTML = list.map(a => {
    // 0-100 整数刻度(core/quota.ts pct())，不再乘 100。
    const pct = Number.isFinite(a.fiveHourRemaining) ? Math.round(a.fiveHourRemaining) : null;
    const weekly = Number.isFinite(a.weeklyRemaining) ? Math.round(a.weeklyRemaining) : null;
    return `
    <div class="card" style="margin-bottom:8px;padding:10px 12px;${a.id === accounts.activeId ? 'border-color:var(--accent)' : ''}">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:12px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis">${escapeHtml(a.email)}</span>
        ${a.id === accounts.activeId ? `<span class="badge">${t('当前')}</span>` : `<button class="btn small" data-switch="${escapeHtml(a.id)}">${t('切换')}</button>`}
      </div>
      <div class="bar" style="margin-top:6px"><div class="${barClass(a.fiveHourRemaining / 100)}" style="width:${pct ?? 0}%"></div></div>
      <div style="font-size:11px;color:var(--fg-faint);margin-top:3px">${t('5h 剩余')} ${pct === null ? '—' : pct + '%'}${weekly !== null ? ` · ${t('周剩余')} ${weekly}%` : ''}</div>
    </div>`;
  }).join('');
  for (const btn of el('content').querySelectorAll('[data-switch]')) {
    btn.onclick = async () => {
      btn.disabled = true;
      try { await invoke('account_switch', { id: btn.dataset.switch }); await refresh(); render(); }
      catch (e) { el('conn').textContent = e.message; }
    };
  }
}

function render() {
  if (mode === 'quota') renderQuota();
  else if (mode === 'usage') renderUsage();
  else renderAccounts();
}

async function refresh() {
  try {
    accounts = await invoke('account_list');
    el('conn').textContent = accounts.identityState === 'verified'
      ? `${t('已连接')} · ${accounts.accounts?.length ?? 0} ${t('个账号')}`
      : t('Antigravity 未运行');
  } catch (e) {
    el('conn').textContent = `${t('加载失败:')}${e.message}`;
  }
  try {
    usage = (await invoke('usage_summary')).summary;
  } catch { /* keep previous */ }
  try {
    config = await invoke('config_get');
    applyLang();
  } catch { /* keep previous */ }
}

async function setMode(m) {
  mode = m;
  for (const [id, key] of [['tab-quota', 'quota'], ['tab-usage', 'usage'], ['tab-accounts', 'accounts']]) {
    el(id).classList.toggle('active', key === m);
  }
  render();
}

/* ---- ··· 快捷菜单 ---- */

function toggleMenu(show) {
  el('tray-menu').hidden = show === undefined ? !el('tray-menu').hidden : !show;
}

el('tray-more').onclick = (e) => { e.stopPropagation(); toggleMenu(); };
document.addEventListener('click', (e) => {
  const menu = el('tray-menu');
  if (!menu.hidden && !menu.contains(e.target)) toggleMenu(false);
});

el('menu-open-main').onclick = async () => {
  toggleMenu(false);
  await window.agbox.openMainWindow();
  window.close();
};
el('open-main').onclick = async () => {
  await window.agbox.openMainWindow();
  window.close();
};
for (const btn of document.querySelectorAll('.menu-lang')) {
  btn.onclick = async () => {
    await invoke('config_set', { patch: { language: btn.dataset.lang } });
    config = await invoke('config_get');
    applyLang();
    render();
  };
}
el('menu-hud').onchange = async () => {
  try { await invoke('hud_set', { enabled: el('menu-hud').checked }); }
  finally { config = await invoke('config_get').catch(() => config); }
};
el('menu-quit').onclick = async () => {
  await window.agbox.quitApp();
};

el('tab-quota').onclick = () => setMode('quota');
el('tab-usage').onclick = () => setMode('usage');
el('tab-accounts').onclick = () => setMode('accounts');

await refresh();
applyLang();
setMode('quota');
setInterval(refresh, 60_000);
