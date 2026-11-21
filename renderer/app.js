// AntigravityBox — main console (7 pages). Vanilla ES module, no framework.
import { invoke, fmtTokens, fmtUsd, fmtPct, fmtTime, fmtBytes, barClass, tierBadge, escapeHtml, showPage } from './common.js';
import { usageEventsCsv, projectMonthlyCost } from '../core/csv.js';
import { t, setLanguage } from './i18n.js';

const state = {
  status: null,
  accounts: null,
  usage: null,
  usagePeriod: 'today',
  config: null,
  recommend: null,          // 智能切换推荐(auto_switch_recommend 投影)
  quotaCollapsed: false,    // 账号页配额收起状态(localStorage 持久化)
  quotaHistoryRange: 24,    // 配额历史曲线范围(小时):24 | 168
  convQuery: '',            // 会话库搜索词
  trayMetric: 'tokens',     // 托盘趋势维度在 tray.js 中独立维护
};

const el = id => document.getElementById(id);

/* ---------------- Overview ---------------- */

function quotaGroupsOf(account) {
  const groups = account?.quota?.quota_groups;
  if (Array.isArray(groups) && groups.length) return groups;
  // Fallback: synthesize family windows from models[] (family_5h/family_weekly fields).
  const models = account?.quota?.models ?? [];
  const bucketsBy = new Map();
  for (const m of models) {
    for (const key of ['family_5h', 'family_weekly']) {
      const w = m[key];
      if (!w || !w.family) continue;
      const window = key === 'family_5h' ? '5h' : 'weekly';
      const gkey = `${w.family}:${window}`;
      if (!bucketsBy.has(gkey)) {
        bucketsBy.set(gkey, {
          display_name: `${w.family} · ${window === '5h' ? '5 小时' : '每周'}`,
          family: w.family,
          buckets: [{ window, remaining_fraction: w.remaining_percentage ?? w.remaining_fraction, remaining_fraction_known: true, reset_countdown: w.reset_countdown ?? '' }],
        });
      }
    }
  }
  return [...bucketsBy.values()];
}

function renderQuotaRows(groups) {
  if (!groups.length) return `<div class="empty">${t('暂无配额数据 — 刷新配额或确认已登录 Antigravity')}</div>`;
  return groups.map(g => {
    for (const b of g.buckets ?? []) {
      const remaining = b.remaining_fraction;
      const known = b.remaining_fraction_known !== false;
      const pct = Number.isFinite(remaining) ? Math.round(remaining * 100) : null;
      const countdown = b.reset_countdown ? ` · ${escapeHtml(b.reset_countdown)}${t('后重置')}` : '';
      return `
      <div class="quota-row">
        <div class="q-head">
          <span class="name">${escapeHtml(g.display_name || g.family || '')} · ${b.window === '5h' ? (langIsEn() ? '5h' : '5 小时') : b.window === 'weekly' ? (langIsEn() ? 'Weekly' : '每周') : escapeHtml(b.window)}</span>
          <span class="pct">${pct === null ? '—' : fmtPct(remaining, known)}</span>
        </div>
        <div class="bar"><div class="${barClass(remaining)}" style="width:${pct === null ? 0 : pct}%"></div></div>
        <div class="q-head"><span class="pct" style="font-size:11px">${countdown}</span></div>
      </div>`;
    }
  }).join('');
}

function langIsEn() { return document.documentElement.lang === 'en'; }

/** 输入/输出/缓存分解条(总览与用量页共用)。 */
function tokenBreakdownRows(period) {
  if (!period) return '';
  const tt = period.totals ?? {};
  const uncachedIn = tt.input_tokens ?? 0;
  const cachedRead = tt.cached_tokens ?? 0;
  const cacheWrite = tt.cache_write_tokens ?? 0;
  const out = tt.output_tokens ?? 0;
  const rows = [
    [t('未缓存输入'), uncachedIn, 'seg-in'],
    [t('缓存读取'), cachedRead, 'seg-cached'],
    [t('缓存写入'), cacheWrite, 'seg-write'],
    [t('输出'), out, 'seg-out'],
  ];
  const total = rows.reduce((n, r) => n + r[1], 0) || 1;
  return `
    <div class="breakdown-bar">
      ${rows.filter(r => r[1] > 0).map(r => `<div class="bd ${r[2]}" style="width:${Math.max(1, Math.round(r[1] / total * 100))}%"></div>`).join('')}
    </div>
    <div class="breakdown-grid">
      ${rows.map(r => `<div class="breakdown-item"><span class="legend-dot ${r[2]}"></span><span class="bd-label">${r[0]}</span><span class="bd-val">${fmtTokens(r[1])}</span></div>`).join('')}
      <div class="breakdown-item"><span class="bd-label">${t('缓存节省')}</span><span class="bd-val">${fmtUsd(period.cacheSavingsUsd)}</span></div>
    </div>`;
}

function pricingBadge(m) {
  if (m.partiallyPriced) return `<span class="badge free">${t('部分计价')}</span>`;
  if (m.priced === false) return `<span class="badge free">${langIsEn() ? 'Unpriced' : '未计价'}</span>`;
  return `<span class="badge pro">${t('已计价')}</span>`;
}

/** 模型表(总览与用量页共用):缓存命中、费用占比、计价徽章。 */
function modelUsageTable(byModel, { compact = false } = {}) {
  const models = (byModel ?? []).slice(0, compact ? 8 : 20);
  if (!models.length) return `<div class="empty">${t(compact ? '今日暂无调用' : '暂无数据')}</div>`;
  const totalCost = models.reduce((n, m) => n + (m.estimated_usd ?? 0), 0) || 1;
  return `<table><thead><tr><th>${t('模型')}</th><th>${t('请求')}</th><th>${t('Token')}</th><th>${t('缓存命中')}</th>${compact ? '' : `<th>${t('输入')}</th><th>${t('输出')}</th><th>${t('缓存节省')}</th>`}<th>${t('费用')}</th><th>${t('费用占比')}</th><th>${t('计价')}</th></tr></thead><tbody>
    ${models.map(m => {
      const denom = (m.input_tokens ?? 0) + (m.cached_tokens ?? 0) + (m.cache_write_tokens ?? 0);
      const hit = denom > 0 ? Math.round((m.cached_tokens ?? 0) / denom * 1000) / 10 : null;
      const share = totalCost > 0 ? (m.estimated_usd ?? 0) / totalCost : 0;
      return `<tr>
      <td class="mono">${escapeHtml(m.model || m.name)}</td>
      <td>${fmtTokens(m.request_count)}</td>
      <td>${fmtTokens(m.total_tokens)}</td>
      <td>${hit === null ? '—' : hit + '%'}</td>
      ${compact ? '' : `<td>${fmtTokens(m.input_tokens)}</td><td>${fmtTokens(m.output_tokens)}</td><td>${fmtUsd(m.cache_savings_usd)}</td>`}
      <td>${fmtUsd(m.estimated_usd)}</td>
      <td><div class="share-cell"><div class="bar tiny"><div style="width:${Math.max(2, Math.round(share * 100))}%"></div></div><span>${Math.round(share * 100)}%</span></div></td>
      <td>${pricingBadge(m)}</td>
    </tr>`;
    }).join('')}
  </tbody></table>`;
}

async function renderOverview() {
  const root = el('page-overview');
  const acct = state.accounts?.accounts?.find(a => a.id === state.accounts?.activeId) ?? state.accounts?.accounts?.[0];
  const usage = state.usage;
  const today = usage?.today;
  const tier = acct?.subscription_tier ?? state.status?.activeSubscriptionTier ?? '';
  const email = acct?.email ?? state.status?.activeAccountEmail ?? state.status?.liveAccountEmail;
  const hud = state.hudStatus ?? (await invoke('hud_status').catch(() => null));
  const history = await invoke('quota_history', { hours: state.quotaHistoryRange }).catch(() => null);
  const hudModeMap = {
    'connected': ['已注入', 'good'],
    'waiting': ['等待应用', 'warn'],
    'waiting-window': ['等待窗口', 'warn'],
    'debug-port-missing': ['未带调试端口', 'warn'],
    'legacy-blocked': ['第三方补丁拦截', 'bad'],
    'paused': ['已暂停', 'muted'],
    'starting': ['启动中', 'muted'],
    'off': ['未启动', 'muted'],
  };
  const [hudText, hudClass] = hudModeMap[hud?.mode] ?? [hud?.mode ?? '未启动', 'muted'];
  const partialPricing = (today?.byModel ?? []).some(m => m.partiallyPriced || m.priced === false);
  root.innerHTML = `
    <h1>${t('总览')}</h1>
    <p class="page-sub">${t('当前账号、双周期配额与今日消耗一屏尽览')}</p>
    ${hud ? `<div class="hud-strip"><span class="dot ${hudClass}"></span><span>${t('界面汉化 / HUD:')}${escapeHtml(hudText)}</span><span class="hud-hint">${escapeHtml(hud?.message ?? '')}</span></div>` : ''}
    <div class="card">
      <div class="acct">
        <div class="head">
          <span class="email">${escapeHtml(email || t('未检测到登录账号'))}</span>
          ${tierBadge(tier)}
          <div class="actions">
            <button class="btn small" id="ov-refresh-quota">${t('刷新配额')}</button>
            <button class="btn small" id="ov-open-accounts">${t('管理账号')}</button>
          </div>
        </div>
        <div>${renderQuotaRows(quotaGroupsOf(acct))}</div>
      </div>
    </div>
    <div class="grid cols-4">
      <div class="card metric"><div class="label">${t('今日 Token')}</div><div class="value">${fmtTokens(today?.totals?.total_tokens)}</div><div class="hint">${t('历史累计')} ${fmtTokens(usage?.all?.totals?.total_tokens)}</div></div>
      <div class="card metric"><div class="label">${t('今日费用估算')}${partialPricing ? ` <span class="badge free">${t('部分计价')}</span>` : ''}</div><div class="value">${fmtUsd(today?.estimatedUsd)}</div><div class="hint">${t('历史累计')} ${fmtUsd(usage?.all?.estimatedUsd)}</div></div>
      <div class="card metric"><div class="label">${t('今日请求数')}</div><div class="value">${fmtTokens(today?.totals?.request_count)}</div><div class="hint">${t('历史累计')} ${fmtTokens(usage?.all?.totals?.request_count)}</div></div>
      <div class="card metric"><div class="label">${t('今日缓存命中')}</div><div class="value">${today ? today.cacheHitRate + '%' : '—'}</div><div class="hint">${t('越高越省额度')}</div></div>
    </div>
    <div class="grid cols-2">
      <div class="card"><h2>${t('今日 Token 明细')}</h2>${tokenBreakdownRows(today)}</div>
      <div class="card"><h2>${t('今日时段消耗')}</h2><div class="trend" id="ov-hourly">${hourlyBars(today?.todayHourly)}</div></div>
    </div>
    <div class="card">
      <div class="card-head-row">
        <h2>${t('配额历史')}</h2>
        <div class="tabs" style="margin:0;">
          <button data-qh="24" class="${state.quotaHistoryRange === 24 ? 'active' : ''}">${t('24 小时')}</button>
          <button data-qh="168" class="${state.quotaHistoryRange === 168 ? 'active' : ''}">${t('7 天')}</button>
        </div>
      </div>
      <div id="ov-quota-history">${quotaHistoryChart(history, email)}</div>
    </div>
    <div class="card"><h2>${t('今日活跃模型')}</h2>${modelUsageTable(today?.byModel, { compact: true })}</div>`;
  el('ov-refresh-quota').onclick = () => runWithSpinner('ov-refresh-quota', async () => {
    if (acct?.id) await invoke('quota_refresh', { id: acct.id });
    await refreshAccounts();
    await renderOverview();
  });
  el('ov-open-accounts').onclick = () => showPage('accounts');
  for (const btn of root.querySelectorAll('[data-qh]')) {
    btn.onclick = async () => {
      state.quotaHistoryRange = Number(btn.dataset.qh);
      await renderOverview();
    };
  }
}

function hourlyBars(hourly) {
  const data = Array.isArray(hourly) && hourly.length ? hourly : Array.from({ length: 24 }, () => 0);
  const max = Math.max(...data.map(d => Number(d?.total_tokens ?? d ?? 0)), 1);
  return data.map(d => {
    const v = Number(d?.total_tokens ?? d ?? 0);
    return `<div class="tbar" style="height:${Math.max(2, Math.round(v / max * 84))}px" title="${fmtTokens(v)}"></div>`;
  }).join('');
}

/** 配额历史 SVG 双曲线(5h / 每周),Y 轴 0-100%,X 轴按快照时间均匀映射。 */
function quotaHistoryChart(history, email) {
  const points = Array.isArray(history?.points) ? history.points : [];
  const series = points
    .map(p => ({
      ts: Number(p.ts),
      five: p.accounts?.find(a => a.email === email)?.fiveHour ?? null,
      weekly: p.accounts?.find(a => a.email === email)?.weekly ?? null,
    }))
    .filter(p => p.five !== null || p.weekly !== null);
  if (series.length < 2) {
    return `<div class="empty">${t('暂无足够的历史数据 — 配额刷新(手动或自动)后会自动积累')}</div>`;
  }
  const w = 620, h = 150, pad = 8;
  const t0 = series[0].ts;
  const t1 = series[series.length - 1].ts || t0 + 1;
  const x = ts => t1 > t0 ? pad + (ts - t0) / (t1 - t0) * (w - pad * 2) : pad;
  const y = v => h - pad - (Math.max(0, Math.min(100, v)) / 100) * (h - pad * 2);
  const path = key => series
    .filter(p => p[key] !== null)
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p[key]).toFixed(1)}`)
    .join(' ');
  const fivePath = path('five');
  const weeklyPath = path('weekly');
  const hasWeekly = series.some(p => p.weekly !== null);
  const fmtClock = ts => {
    const d = new Date(ts * 1000);
    return state.quotaHistoryRange === 24
      ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`;
  };
  return `
    <svg class="qhistory" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">
      <line x1="${pad}" y1="${y(25)}" x2="${w - pad}" y2="${y(25)}" class="qh-grid" />
      <line x1="${pad}" y1="${y(50)}" x2="${w - pad}" y2="${y(50)}" class="qh-grid" />
      <line x1="${pad}" y1="${y(75)}" x2="${w - pad}" y2="${y(75)}" class="qh-grid" />
      ${weeklyPath ? `<path d="${weeklyPath}" class="qh-line qh-weekly" />` : ''}
      ${fivePath ? `<path d="${fivePath}" class="qh-line qh-five" />` : ''}
    </svg>
    <div class="qh-legend">
      <span><span class="legend-dot qh-five"></span>${langIsEn() ? 'Shared pool 5h' : '共享池 5 小时'}</span>
      ${hasWeekly ? `<span><span class="legend-dot qh-weekly"></span>${langIsEn() ? 'Weekly' : '每周'}</span>` : ''}
      <span class="qh-range">${fmtClock(series[0].ts)} → ${fmtClock(series[series.length - 1].ts)} · ${series.length} ${t('个采样点')}</span>
    </div>`;
}

/* ---------------- Cost donut (usage page) ---------------- */

const DONUT_COLORS = ['#4285f4', '#1a9a5c', '#e2a336', '#9b72f2', '#e26a8d', '#26a6b8', '#7cb342', '#f26a3d', '#5f6673'];

function costDonut(byModel) {
  const models = (byModel ?? []).filter(m => (m.estimated_usd ?? 0) > 0).slice(0, 8);
  if (!models.length) return `<div class="empty">${t('暂无数据')}</div>`;
  const total = models.reduce((n, m) => n + (m.estimated_usd ?? 0), 0);
  const rest = (byModel ?? []).slice(8).reduce((n, m) => n + (m.estimated_usd ?? 0), 0);
  const items = models.map((m, i) => ({ label: m.model, value: m.estimated_usd, color: DONUT_COLORS[i % DONUT_COLORS.length] }));
  if (rest > 0) items.push({ label: t('其他'), value: rest, color: DONUT_COLORS[DONUT_COLORS.length - 1] });
  let acc = 0;
  const stops = items.map(it => {
    const from = acc / total * 360; acc += it.value; const to = acc / total * 360;
    return `${it.color} ${from.toFixed(1)}deg ${to.toFixed(1)}deg`;
  }).join(',');
  return `
    <div class="donut-wrap">
      <div class="donut" style="background:conic-gradient(${stops})">
        <div class="donut-hole"><div class="donut-total">${fmtUsd(total)}</div><div class="donut-label">${t('费用估算')}</div></div>
      </div>
      <div class="donut-legend">
        ${items.map(it => `<div class="legend-item"><span class="legend-dot" style="background:${it.color}"></span><span class="legend-label mono">${escapeHtml(it.label)}</span><span class="legend-val">${fmtUsd(it.value)} · ${Math.round(it.value / total * 100)}%</span></div>`).join('')}
      </div>
    </div>`;
}

/* ---------------- Request detail modal ---------------- */

const detail = { open: false, query: '', offset: 0, limit: 25, rows: [], total: 0, loading: false };

function ensureDetailModal() {
  if (el('detail-mask')) return;
  const mask = document.createElement('div');
  mask.id = 'detail-mask';
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>${t('请求明细')}</h2>
        <div class="modal-tools">
          <input type="text" id="detail-query" placeholder="${t('按模型名搜索…')}" />
          <button class="btn small" id="detail-search">${t('搜索')}</button>
          <button class="btn small" id="detail-export">${t('导出 JSON')}</button>
          <button class="btn small" id="detail-export-csv">${t('导出 CSV')}</button>
          <button class="btn small" id="detail-close">${t('关闭')}</button>
        </div>
      </div>
      <div class="modal-body" id="detail-body"></div>
      <div class="modal-foot">
        <button class="btn small" id="detail-prev">${t('上一页')}</button>
        <span id="detail-page" style="font-size:12px;color:var(--fg-muted)"></span>
        <button class="btn small" id="detail-next">${t('下一页')}</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', e => { if (e.target === mask) closeDetailModal(); });
  el('detail-close').onclick = () => closeDetailModal();
  el('detail-search').onclick = async () => {
    detail.query = el('detail-query').value.trim();
    detail.offset = 0;
    await loadDetailRows();
  };
  el('detail-query').addEventListener('keydown', e => { if (e.key === 'Enter') el('detail-search').click(); });
  el('detail-prev').onclick = async () => {
    if (detail.offset > 0) { detail.offset = Math.max(0, detail.offset - detail.limit); await loadDetailRows(); }
  };
  el('detail-next').onclick = async () => {
    if (detail.offset + detail.limit < detail.total) { detail.offset += detail.limit; await loadDetailRows(); }
  };
  el('detail-export').onclick = () => exportUsageJson('events');
  el('detail-export-csv').onclick = () => exportUsageJson('events_csv');
}

function closeDetailModal() {
  detail.open = false;
  el('detail-mask')?.remove();
}

async function loadDetailRows() {
  detail.loading = true;
  renderDetailTable();
  try {
    const res = await invoke('usage_events', { period: state.usagePeriod, query: detail.query, offset: detail.offset, limit: detail.limit });
    detail.rows = res.rows ?? [];
    detail.total = res.total ?? 0;
  } catch (error) {
    detail.rows = [];
    detail.total = 0;
    renderDetailTable(error.message);
    detail.loading = false;
    return;
  }
  detail.loading = false;
  renderDetailTable();
}

function renderDetailTable(errorMessage) {
  const body = el('detail-body');
  if (!body) return;
  if (errorMessage) { body.innerHTML = `<div class="error-box">${escapeHtml(errorMessage)}</div>`; return; }
  if (detail.loading) { body.innerHTML = `<div class="loading">…</div>`; return; }
  if (!detail.rows.length) { body.innerHTML = `<div class="empty">${t('暂无匹配的请求记录')}</div>`; }
  else {
    body.innerHTML = `<table><thead><tr><th>${t('时间')}</th><th>${t('模型')}</th><th>${t('输入')}</th><th>${t('缓存读取')}</th><th>${t('缓存写入')}</th><th>${t('输出')}</th><th>${t('总计')}</th><th>${t('费用')}</th></tr></thead><tbody>
      ${detail.rows.map(r => `<tr>
        <td>${fmtTime(r.timestamp_seconds)}</td>
        <td class="mono">${escapeHtml(r.model)}</td>
        <td>${fmtTokens(r.input_tokens)}</td>
        <td>${fmtTokens(r.cached_tokens)}</td>
        <td>${fmtTokens(r.cache_write_tokens ?? 0)}</td>
        <td>${fmtTokens(r.output_tokens)}</td>
        <td>${fmtTokens(r.total_tokens)}</td>
        <td>${r.priced === false ? `<span class="badge free">${langIsEn() ? 'Unpriced' : '未计价'}</span>` : fmtUsd(r.estimated_usd)}</td>
      </tr>`).join('')}
    </tbody></table>`;
  }
  const page = el('detail-page');
  if (page) page.textContent = `${t('第')}${detail.total ? Math.floor(detail.offset / detail.limit) + 1 : 0}${t(' / ')}${Math.max(1, Math.ceil(detail.total / detail.limit))}${t(' · ')}${detail.total} ${t('请求')}`;
}

async function openDetailModal() {
  ensureDetailModal();
  detail.open = true;
  detail.query = '';
  detail.offset = 0;
  el('detail-query').value = '';
  await loadDetailRows();
}

/* ---------------- Export ---------------- */

async function fetchAllEvents(period, query) {
  const rows = [];
  let offset = 0;
  const limit = 500;
  for (;;) {
    const res = await invoke('usage_events', { period, query, offset, limit });
    rows.push(...(res.rows ?? []));
    offset += limit;
    if (!res.rows?.length || rows.length >= 5000 || offset >= (res.total ?? 0)) break;
  }
  return rows;
}

async function exportUsageJson(kind) {
  if (kind === 'summary') {
    const payload = { exported_at: new Date().toISOString(), period: state.usagePeriod, summary: state.usage };
    const r = await window.agbox.exportJson(`antigravitybox-usage-${state.usagePeriod}.json`, JSON.stringify(payload, null, 2));
    if (r && r.ok && !r.canceled) flashExport();
    return;
  }
  // events / events_csv: page through usage_events (cap 5000 rows to keep memory bounded)
  const rows = await fetchAllEvents(state.usagePeriod, detail.open ? detail.query : '');
  if (kind === 'events_csv') {
    const r = await window.agbox.exportJson(
      `antigravitybox-events-${state.usagePeriod}.csv`,
      usageEventsCsv(rows),
      { name: 'CSV', extensions: ['csv'] },
    );
    if (r && r.ok && !r.canceled) flashExport();
    return;
  }
  const payload = { exported_at: new Date().toISOString(), period: state.usagePeriod, total: rows.length, events: rows };
  const r = await window.agbox.exportJson(`antigravitybox-events-${state.usagePeriod}.json`, JSON.stringify(payload, null, 2));
  if (r && r.ok && !r.canceled) flashExport();
}

function flashExport() {
  const box = document.createElement('div');
  box.className = 'success-box';
  box.textContent = langIsEn() ? 'Export complete' : '导出完成';
  document.querySelector('.page.active')?.prepend(box);
  setTimeout(() => box.remove(), 5000);
}

/* ---------------- Usage page ---------------- */

async function renderUsage() {
  const root = el('page-usage');
  const summary = state.usage;
  const p = summary?.[state.usagePeriod];
  const avg = p?.totals?.request_count > 0 ? Math.round(p.totals.total_tokens / p.totals.request_count) : null;
  // 月费用预测固定按近 7 天外推(与所选时间范围无关,避免短周期放大误差)。
  const monthlyCost = projectMonthlyCost(summary?.['7d']?.estimatedUsd);
  root.innerHTML = `
    <h1>${t('用量')}</h1>
    <p class="page-sub">${t('来自本地会话数据库的只读扫描 · 共')} ${summary?.databasesScanned ?? '—'} ${t('个会话库')}</p>
    <div class="tabs">
      ${[['today', t('今日')], ['7d', t('近 7 天')], ['30d', t('近 30 天')], ['all', t('全部')]].map(([k, label]) =>
        `<button data-period="${k}" class="${state.usagePeriod === k ? 'active' : ''}">${label}</button>`).join('')}
    </div>
    ${summary?.hasError ? `<div class="error-box">${t('部分数据库读取失败 — 报告可能不完整')}</div>` : ''}
    <div class="grid cols-4">
      <div class="card metric"><div class="label">${t('总 Token')}</div><div class="value">${fmtTokens(p?.totals?.total_tokens)}</div></div>
      <div class="card metric"><div class="label">${t('费用估算')}</div><div class="value">${fmtUsd(p?.estimatedUsd)}</div></div>
      <div class="card metric"><div class="label">${t('请求数')}</div><div class="value">${fmtTokens(p?.totals?.request_count)}</div></div>
      <div class="card metric"><div class="label">${t('缓存命中')}</div><div class="value">${p ? p.cacheHitRate + '%' : '—'}</div></div>
    </div>
    <div class="card req-cache-row">
      <div class="req-stat"><span class="label">${t('请求数')}</span><span class="val">${fmtTokens(p?.totals?.request_count)}</span></div>
      <div class="req-stat"><span class="label">${t('平均单次 Token')}</span><span class="val">${avg === null ? '—' : fmtTokens(avg)}</span></div>
      <div class="req-stat"><span class="label">${t('缓存命中')}</span><span class="val">${p ? p.cacheHitRate + '%' : '—'}</span></div>
      <div class="req-stat"><span class="label">${t('缓存节省')}</span><span class="val">${fmtUsd(p?.cacheSavingsUsd)}</span></div>
      <div class="req-stat"><span class="label">${t('月费用预测')}</span><span class="val">${monthlyCost === null ? '—' : fmtUsd(monthlyCost)}</span></div>
      <div class="req-actions">
        <button class="btn small" id="usage-detail">${t('请求明细…')}</button>
        <button class="btn small" id="usage-export-summary">${t('导出汇总 JSON')}</button>
        <button class="btn small" id="usage-export-events">${t('导出请求明细 JSON')}</button>
        <button class="btn small" id="usage-export-csv">${t('导出明细 CSV')}</button>
      </div>
    </div>
    <div class="grid cols-2">
      <div class="card"><h2>${t('趋势')}</h2><div class="trend">${trendBars(p?.dailyTrends)}</div></div>
      <div class="card"><h2>${t('Token 明细')}</h2>${tokenBreakdownRows(p)}</div>
    </div>
    <div class="card"><h2>${t('费用环图')}</h2>${costDonut(p?.byModel)}</div>
    <div class="card"><h2>${t('按模型')}</h2>${modelUsageTable(p?.byModel)}</div>`;
  for (const btn of root.querySelectorAll('[data-period]')) {
    btn.onclick = async () => {
      state.usagePeriod = btn.dataset.period;
      await renderUsage();
    };
  }
  el('usage-detail').onclick = () => openDetailModal();
  el('usage-export-summary').onclick = () => exportUsageJson('summary');
  el('usage-export-events').onclick = () => exportUsageJson('events');
  el('usage-export-csv').onclick = () => exportUsageJson('events_csv');
}

function trendBars(trends) {
  const data = Array.isArray(trends) ? trends : [];
  if (!data.length) return `<div class="empty">${t('暂无数据')}</div>`;
  const max = Math.max(...data.map(d => Number(d?.total_tokens ?? d ?? 0)), 1);
  return data.map(d => {
    const v = Number(d?.total_tokens ?? d ?? 0);
    const day = d?.date ? String(d.date).slice(5) : '';
    return `<div class="tbar" style="height:${Math.max(2, Math.round(v / max * 84))}px" title="${day || ''} ${fmtTokens(v)}"></div>`;
  }).join('');
}

/* ---------------- Conversations (会话库,只读) ---------------- */

const convDetail = { open: false, file: '', rows: [], loading: false };

async function renderConversations() {
  const root = el('page-conversations');
  root.innerHTML = `
    <h1>${t('会话库')}</h1>
    <p class="page-sub">${t('本地会话数据库只读浏览 · 指标脱敏,不含对话内容')}</p>
    <div class="card">
      <div style="display:flex;gap:10px;">
        <input type="text" id="conv-query" placeholder="${t('按会话 ID 搜索…')}" value="${escapeHtml(state.convQuery)}" style="width:280px" />
        <button class="btn small" id="conv-search">${t('搜索')}</button>
        <div style="flex:1"></div>
        <button class="btn small" id="conv-reload">${t('重新加载')}</button>
      </div>
      <div id="conv-list" style="margin-top:12px;"></div>
    </div>`;
  el('conv-search').onclick = () => runWithSpinner('conv-search', async () => {
    state.convQuery = el('conv-query').value.trim();
    await renderConversationList();
  });
  el('conv-query').addEventListener('keydown', e => { if (e.key === 'Enter') el('conv-search').click(); });
  el('conv-reload').onclick = () => runWithSpinner('conv-reload', renderConversationList);
  await renderConversationList();
}

async function renderConversationList() {
  const res = await invoke('conversations_list');
  const all = Array.isArray(res.conversations) ? res.conversations : [];
  const q = state.convQuery.toLowerCase();
  const list = q ? all.filter(c => String(c.file).toLowerCase().includes(q)) : all;
  const box = el('conv-list');
  if (!list.length) {
    box.innerHTML = `<div class="empty">${all.length ? t('没有匹配的会话') : t('未发现会话数据库 — Antigravity 首次对话后会生成')}</div>`;
    return;
  }
  box.innerHTML = `<table><thead><tr><th>${t('会话')}</th><th>${t('大小')}</th><th>${t('请求数')}</th><th>${t('Token')}</th><th>${t('模型')}</th><th>${t('最近活动')}</th><th></th></tr></thead><tbody>
    ${list.slice(0, 200).map(c => `<tr>
      <td class="mono" title="${escapeHtml(c.file)}">${escapeHtml(String(c.file).replace(/\.db$/, '').slice(0, 13))}…</td>
      <td>${fmtBytes(c.sizeBytes)}</td>
      <td>${fmtTokens(c.requests)}</td>
      <td>${fmtTokens(c.tokens)}</td>
      <td>${fmtTokens(c.models)}</td>
      <td>${c.lastTs ? fmtTime(c.lastTs) : (c.mtimeMs ? fmtTime(Math.floor(c.mtimeMs / 1000)) : '—')}</td>
      <td><button class="btn small conv-open" data-file="${escapeHtml(c.file)}">${t('明细…')}</button></td>
    </tr>`).join('')}
  </tbody></table>
  ${list.length > 200 ? `<div class="empty">${t('仅显示最近')} 200 ${t('个会话')}</div>` : ''}`;
  for (const btn of box.querySelectorAll('.conv-open')) {
    btn.onclick = () => runWithSpinner(null, () => openConversationDetail(btn.dataset.file));
  }
}

function conversationMarkdown(file, events) {
  const total = events.reduce((n, e) => n + (e.total_tokens ?? 0), 0);
  const cost = events.reduce((n, e) => n + (e.estimated_usd ?? 0), 0);
  const head = [
    `# ${t('会话')} ${file}`,
    '',
    `- ${t('导出时间')}:${new Date().toLocaleString()}`,
    `- ${t('请求数')}:${events.length}`,
    `- ${t('Token 合计')}:${total}`,
    `- ${t('费用估算')}:${'$' + cost.toFixed(4)}`,
    '',
    `| ${t('时间')} | ${t('模型')} | ${t('输入')} | ${t('缓存读取')} | ${t('缓存写入')} | ${t('输出')} | ${t('总计')} | ${t('费用USD')} |`,
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  const body = events.map(e => [
    e.timestamp_seconds ? new Date(e.timestamp_seconds * 1000).toLocaleString() : '—',
    String(e.model ?? ''),
    String(e.input_tokens ?? 0),
    String(e.cached_tokens ?? 0),
    String(e.cache_write_tokens ?? 0),
    String(e.output_tokens ?? 0),
    String(e.total_tokens ?? 0),
    (e.estimated_usd ?? 0).toFixed(4),
  ].map(cell => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | '));
  return head.join('\n') + '\n' + body.map(l => `| ${l} |`).join('\n') + '\n';
}

function ensureConvModal() {
  if (el('conv-mask')) return;
  const mask = document.createElement('div');
  mask.id = 'conv-mask';
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2 id="conv-title"></h2>
        <div class="modal-tools">
          <button class="btn small" id="conv-export">${t('导出 Markdown')}</button>
          <button class="btn small" id="conv-close">${t('关闭')}</button>
        </div>
      </div>
      <div class="modal-body" id="conv-body"></div>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', e => { if (e.target === mask) closeConvModal(); });
  el('conv-close').onclick = () => closeConvModal();
  el('conv-export').onclick = async () => {
    const r = await window.agbox.exportJson(
      `antigravitybox-conversation-${convDetail.file.replace(/\.db$/, '')}.md`,
      conversationMarkdown(convDetail.file, convDetail.rows),
      { name: 'Markdown', extensions: ['md'] },
    );
    if (r && r.ok && !r.canceled) flashExport();
  };
}

function closeConvModal() {
  convDetail.open = false;
  el('conv-mask')?.remove();
}

async function openConversationDetail(file) {
  ensureConvModal();
  convDetail.open = true;
  convDetail.file = file;
  convDetail.rows = [];
  el('conv-title').textContent = `${t('会话明细')} — ${file.replace(/\.db$/, '')}`;
  el('conv-body').innerHTML = `<div class="loading">…</div>`;
  try {
    const res = await invoke('conversations_events', { file });
    convDetail.rows = res.events ?? [];
  } catch (error) {
    el('conv-body').innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!convDetail.rows.length) {
    el('conv-body').innerHTML = `<div class="empty">${t('账本中暂无该会话的请求记录(账本不可用或会话早于账本建立)')}</div>`;
    return;
  }
  el('conv-body').innerHTML = `<table><thead><tr><th>${t('时间')}</th><th>${t('模型')}</th><th>${t('输入')}</th><th>${t('缓存读取')}</th><th>${t('缓存写入')}</th><th>${t('输出')}</th><th>${t('总计')}</th><th>${t('费用')}</th></tr></thead><tbody>
    ${convDetail.rows.map(r => `<tr>
      <td>${fmtTime(r.timestamp_seconds)}</td>
      <td class="mono">${escapeHtml(r.model)}</td>
      <td>${fmtTokens(r.input_tokens)}</td>
      <td>${fmtTokens(r.cached_tokens)}</td>
      <td>${fmtTokens(r.cache_write_tokens ?? 0)}</td>
      <td>${fmtTokens(r.output_tokens)}</td>
      <td>${fmtTokens(r.total_tokens)}</td>
      <td>${r.priced === false ? `<span class="badge free">${langIsEn() ? 'Unpriced' : '未计价'}</span>` : fmtUsd(r.estimated_usd)}</td>
    </tr>`).join('')}
  </tbody></table>`;
}



/* ---------------- Accounts ---------------- */

const MONITORED_OPTIONS = [
  ['all', t('主力共享池(Gemini + Claude/GPT)')],
  ['gemini_all', t('Gemini 全系(含独立高阶周配额)')],
  ['gemini', t('仅基础 Gemini 池')],
  ['claude', t('仅 Claude/GPT 池')],
];

async function renderAccounts() {
  const root = el('page-accounts');
  const data = state.accounts;
  const recovery = data?.recovery;
  if (!('quotaCollapsed' in state)) {
    try { state.quotaCollapsed = localStorage.getItem('agbox.quotaCollapsed') === '1'; } catch { state.quotaCollapsed = false; }
  }
  root.innerHTML = `
    <h1>${t('账号')}</h1>
    <p class="page-sub">${t('多账号保存与安全切换 · 绝不后台强杀 Antigravity')}</p>
    ${recovery?.pending ? `<div class="error-box">${t('上一次切换未正常完成（')}${escapeHtml(recovery.status)}${t('）— 请先在下方撤销恢复。')}</div>` : ''}
    <div class="card">
      <div style="display:flex;gap:10px;margin-bottom:8px;">
        <button class="btn primary" id="ac-save-current">${t('保存当前账号…')}</button>
        <button class="btn" id="ac-refresh">${t('刷新配额(全部)')}</button>
        <div style="flex:1"></div>
        <button class="btn" id="ac-collapse">${t(state.quotaCollapsed ? '展开配额' : '收起配额')}</button>
        <button class="btn" id="ac-reload">${t('重新加载')}</button>
      </div>
      <div id="ac-list">${accountCards(data)}</div>
    </div>
    ${recovery?.available ? `
    <div class="card">
      <h2>${t('恢复点')}</h2>
      <div>${t('状态:')}${escapeHtml(recovery.status)} · ${t('创建于')} ${fmtTime(recovery.createdAt)}</div>
      <div style="margin-top:10px;display:flex;gap:10px;">
        <button class="btn primary" id="ac-rollback">${t('撤销并恢复原账号')}</button>
      </div>
    </div>` : ''}
    <div class="card">
      <h2>${t('智能切换')}</h2>
      <div id="ac-autoswitch">${renderAutoSwitch(state.config?.autoSwitch, state.recommend)}</div>
    </div>`;
  el('ac-save-current').onclick = () => runWithSpinner('ac-save-current', async () => {
    await invoke('account_save_current');
    await refreshAccounts();
    await renderAccounts();
  });
  el('ac-refresh').onclick = () => runWithSpinner('ac-refresh', async () => {
    await invoke('quota_refresh_all');
    await refreshAccounts();
    await refreshRecommend();
    await renderAccounts();
  });
  el('ac-reload').onclick = () => runWithSpinner('ac-reload', async () => {
    await refreshAccounts();
    await refreshRecommend();
    await renderAccounts();
  });
  el('ac-collapse').onclick = async () => {
    state.quotaCollapsed = !state.quotaCollapsed;
    try { localStorage.setItem('agbox.quotaCollapsed', state.quotaCollapsed ? '1' : '0'); } catch { /* 私有模式等 */ }
    await renderAccounts();
  };
  const rollbackBtn = el('ac-rollback');
  if (rollbackBtn) rollbackBtn.onclick = () => runWithSpinner('ac-rollback', async () => {
    await invoke('account_switch_rollback');
    await refreshAccounts();
    await renderAccounts();
  });
  for (const btn of root.querySelectorAll('[data-switch]')) {
    btn.onclick = () => runWithSpinner(null, async () => {
      await invoke('account_switch', { id: btn.dataset.switch });
      await refreshAccounts();
      await renderAccounts();
    });
  }
  for (const btn of root.querySelectorAll('[data-qrefresh]')) {
    btn.onclick = () => runWithSpinner(null, async () => {
      await invoke('quota_refresh', { id: btn.dataset.qrefresh });
      await refreshAccounts();
      await renderAccounts();
    });
  }
  bindAutoSwitchControls(root);
}

function accountCompactSummary(a) {
  // 折叠态胶囊摘要:Gemini 91% · Claude/GPT 0%(与上游账号页收起态一致)
  const groups = a?.quota?.quota_groups ?? [];
  const parts = [];
  for (const g of groups) {
    for (const b of g.buckets ?? []) {
      const remaining = b.remaining_fraction;
      if (!Number.isFinite(remaining)) continue;
      const label = (g.family || g.display_name || '').toUpperCase();
      const window = b.window === '5h' ? (langIsEn() ? '5h' : '5h') : (langIsEn() ? 'W' : '周');
      parts.push(`${escapeHtml(label)} ${Math.round(remaining * 100)}%`);
      void window;
    }
  }
  if (!parts.length) {
    const pct = Number.isFinite(a.fiveHourRemaining) ? Math.round(a.fiveHourRemaining) : null;
    if (pct !== null) parts.push(`${langIsEn() ? '5h' : '共享池'} ${pct}%`);
  }
  return parts.join(' · ') || '—';
}

function accountCards(data) {
  const accounts = data?.accounts ?? [];
  if (!accounts.length) return `<div class="empty">${t('还没有保存的账号 — 点击「保存当前账号」导入 Antigravity 正在使用的登录')}</div>`;
  return accounts.map(a => {
    // 五小时/每周余量在核心层已折算为 0-100 整数(core/quota.ts pct())，此处不再乘 100。
    const pct = Number.isFinite(a.fiveHourRemaining) ? Math.round(a.fiveHourRemaining) : null;
    const weekly = Number.isFinite(a.weeklyRemaining) ? Math.round(a.weeklyRemaining) : null;
    const recommended = state.recommend?.bestCandidate?.id === a.id;
    return `
    <div class="card acct ${a.id === data.activeId ? 'active' : ''}">
      <div class="head">
        <span class="email">${escapeHtml(a.email)}</span>
        ${a.name ? `<span style="color:var(--fg-muted)">${escapeHtml(a.name)}</span>` : ''}
        ${tierBadge(a.subscription_tier)}
        ${a.id === data.activeId ? `<span class="badge">${t('当前')}</span>` : ''}
        ${recommended ? `<span class="badge pro">${t('推荐备用')}${Number.isFinite(state.recommend?.bestCandidate?.remaining) ? ` ${state.recommend.bestCandidate.remaining}%` : ''}</span>` : ''}
        <div class="actions">
          <button class="btn small" data-qrefresh="${escapeHtml(a.id)}">${langIsEn() ? 'Refresh' : '刷新'}</button>
          ${a.id === data.activeId ? '' : `<button class="btn small primary" data-switch="${escapeHtml(a.id)}">${t('切换')}</button>`}
        </div>
      </div>
      ${state.quotaCollapsed
        ? `<div class="quota-compact">${accountCompactSummary(a)}</div>`
        : `
      <div class="quota-row">
        <div class="q-head"><span class="name">${t('共享池 5 小时')}</span><span class="pct">${pct === null ? '—' : pct + '%'}</span></div>
        <div class="bar"><div class="${barClass(a.fiveHourRemaining / 100)}" style="width:${pct ?? 0}%"></div></div>
      </div>
      <div class="quota-row">
        <div class="q-head"><span class="name">${t('共享池 每周')}</span><span class="pct">${weekly === null ? '—' : weekly + '%'}</span></div>
        <div class="bar"><div class="${barClass(a.weeklyRemaining / 100)}" style="width:${weekly ?? 0}%"></div></div>
      </div>`}
    </div>`;
  }).join('');
}

function renderAutoSwitch(cfg, recommend) {
  const enabled = cfg?.enabled === true;
  const strategy = cfg?.strategy === 'round_robin' ? 'round_robin' : 'priority';
  const monitored = cfg?.monitored_model ?? 'all';
  const reserve = cfg?.reserve_percentage ?? 10;
  const candidateMin = cfg?.candidate_min_percentage ?? 30;
  return `
    <div class="setting-row" style="border-bottom:none;">
      <div class="info">
        <div class="title">${t('智能切换')}</div>
        <div class="desc">${t('开启后额度偏低时标记推荐备用账号 — 所有切换均需手动确认,绝不自动强杀')}</div>
        ${recommend?.enabled && recommend.shouldSwitch && recommend.bestCandidate
          ? `<div class="success-box" style="margin-top:8px;">${t('推荐候选')}: ${escapeHtml(recommend.bestCandidate.email)}${Number.isFinite(recommend.bestCandidate.remaining) ? ` (${recommend.bestCandidate.remaining}%)` : ''} — ${escapeHtml(recommend.reason)}</div>`
          : recommend?.enabled ? `<div style="margin-top:8px;font-size:12px;color:var(--fg-muted)">${t('当前账号配额健康,暂无推荐')}</div>` : ''}
      </div>
      <label class="switch"><input type="checkbox" id="as-enabled" ${enabled ? 'checked' : ''} /><span class="slider"></span></label>
    </div>
    <div id="as-config" class="as-config" ${enabled ? '' : 'hidden'}>
      <div class="as-grid">
        <label>${t('推荐排序方式')}
          <select id="as-strategy">
            <option value="priority" ${strategy === 'priority' ? 'selected' : ''}>${t('配额充裕优先')}</option>
            <option value="round_robin" ${strategy === 'round_robin' ? 'selected' : ''}>${t('按顺序轮询')}</option>
          </select>
        </label>
        <label>${t('监测模型范围')}
          <select id="as-monitored">
            ${MONITORED_OPTIONS.map(([v, label]) => `<option value="${v}" ${monitored === v ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        <label>${t('触发切换阈值')} <span class="pct">%</span>
          <input type="text" id="as-reserve" value="${reserve}" inputmode="numeric" />
        </label>
        <label>${t('候选准入下限')} <span class="pct">%</span>
          <input type="text" id="as-candidate-min" value="${candidateMin}" inputmode="numeric" />
        </label>
      </div>
      <div style="display:flex;gap:10px;margin-top:10px;">
        <button class="btn primary small" id="as-save">${t('保存规则')}</button>
      </div>
    </div>`;
}

function bindAutoSwitchControls(root) {
  const enabledToggle = root.querySelector('#as-enabled');
  enabledToggle?.addEventListener('change', async () => {
    enabledToggle.disabled = true;
    try {
      await invoke('auto_switch_set', { config: { enabled: enabledToggle.checked } });
      state.config = await invoke('config_get');
    } catch (error) {
      alert(`${t('操作失败:')}${error.message}`);
      enabledToggle.checked = !enabledToggle.checked;
    }
    enabledToggle.disabled = false;
    await renderAccounts();
  });
  const save = root.querySelector('#as-save');
  save?.addEventListener('click', async () => {
    const reserve = Number(root.querySelector('#as-reserve').value);
    const candidateMin = Number(root.querySelector('#as-candidate-min').value);
    if (!Number.isFinite(reserve) || reserve < 1 || reserve > 98) {
      alert(langIsEn() ? 'Trigger threshold must be 1-98' : '触发切换阈值须在 1-98 之间');
      return;
    }
    if (!Number.isFinite(candidateMin) || candidateMin < 2 || candidateMin > 100) {
      alert(langIsEn() ? 'Candidate minimum must be 2-100' : '候选准入下限须在 2-100 之间');
      return;
    }
    if (reserve >= candidateMin) {
      alert(langIsEn() ? 'Candidate minimum must be greater than the trigger threshold' : '候选准入下限必须大于触发切换阈值');
      return;
    }
    await runWithSpinner('as-save', async () => {
      await invoke('auto_switch_set', {
        config: {
          strategy: root.querySelector('#as-strategy').value,
          monitored_model: root.querySelector('#as-monitored').value,
          reserve_percentage: reserve,
          candidate_min_percentage: candidateMin,
        },
      });
      state.config = await invoke('config_get');
      await refreshRecommend();
    });
    await renderAccounts();
  });
}

async function refreshRecommend() {
  state.recommend = await invoke('auto_switch_recommend').catch(() => null);
}

/* ---------------- Storage (M3) ---------------- */

async function renderStorage() {
  const root = el('page-storage');
  root.innerHTML = `
    <h1>${t('存储')}</h1>
    <p class="page-sub">${t('可撤回的无损清理 · 快照 + 回收仓,绝不直接抹除')}</p>
    <div class="card">
      <div style="display:flex;gap:10px;">
        <button class="btn primary" id="st-scan">${t('重新扫描')}</button>
        <button class="btn" id="st-history">${t('清理历史')}</button>
      </div>
      <div id="st-result" style="margin-top:14px;"></div>
    </div>`;
  el('st-scan').onclick = () => runWithSpinner('st-scan', renderStorageScan);
  el('st-history').onclick = () => runWithSpinner('st-history', renderStorageHistory);
  await renderStorageScan();
}

function stSnapshotBadge(s) {
  if (s.restoredAt) return `<span class="badge free">${t('已恢复')}</span>`;
  if (s.interrupted) return `<span class="badge free">${t('中断待处理')}</span>`;
  return s.restorable ? `<span class="badge pro">${t('可恢复')}</span>` : `<span class="badge free">${t('不可恢复')}</span>`;
}

function stSnapshotTable(snapshots) {
  if (!snapshots.length) return `<div class="empty">${t('暂无清理快照')}</div>`;
  return `<table><thead><tr><th>${t('快照')}</th><th>${t('时间')}</th><th>${t('大小')}</th><th>${t('文件')}</th><th>${t('状态')}</th><th></th></tr></thead><tbody>
    ${snapshots.map(s => `<tr>
      <td>${escapeHtml(s.id)}</td>
      <td>${fmtTime(s.at ?? s.timestamp)}</td>
      <td>${fmtBytes(s.totalBytes)}</td>
      <td>${fmtTokens(s.fileCount)}</td>
      <td>${stSnapshotBadge(s)}</td>
      <td>${s.restorable ? `<button class="btn small st-restore" data-id="${escapeHtml(s.id)}">${t('恢复')}</button>` : ''}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

async function renderStorageHistory() {
  const { history } = await invoke('maintenance_history');
  el('st-result').innerHTML = `<h2 style="margin-top:6px;">${t('清理快照')}</h2>${stSnapshotTable(Array.isArray(history) ? history : [])}`;
}

async function renderStorageScan() {
  const root = el('page-storage');
  const scan = await invoke('maintenance_scan');
  const entries = Array.isArray(scan.entries) ? scan.entries : [];
  const snapshots = Array.isArray(scan.snapshots) ? scan.snapshots : [];
  const rc = scan.buckets?.runtimeCache ?? {};
  const hl = scan.buckets?.historyLogs ?? {};
  const canPick = e => e.clearable !== false && e.bytes > 0;
  el('st-result').innerHTML = `
    ${scan.running ? `<div class="error-box">${t('Antigravity 正在运行 — 清理与恢复会被安全拒绝;请先退出 Antigravity 再操作。')}</div>` : ''}
    <div class="grid cols-2">
      <div class="card metric"><div class="label">${t('运行缓存(安全)')}</div><div class="value">${fmtBytes(rc.clearableBytes ?? 0)}</div><div class="hint">${fmtTokens(rc.fileCount ?? 0)} ${t('个文件 · 重启自动重建')}</div></div>
      <div class="card metric"><div class="label">${t('历史日志(可瘦身)')}</div><div class="value">${fmtBytes(hl.clearableBytes ?? 0)}</div><div class="hint">${fmtTokens(hl.fileCount ?? 0)} ${t('个文件 · 保留最近')} ${hl.retentionDays ?? '—'} ${t('天')}</div></div>
    </div>
    <table><thead><tr><th></th><th>${t('项目')}</th><th>${t('类别')}</th><th>${t('大小')}</th><th>${t('文件')}</th></tr></thead><tbody>
      ${entries.map(e => `<tr>
        <td><input type="checkbox" class="st-item" data-name="${escapeHtml(e.name)}" ${canPick(e) && e.defaultSelected !== false ? 'checked' : ''} ${canPick(e) ? '' : 'disabled'} /></td>
        <td>${escapeHtml(e.name)}</td>
        <td>${e.category === 'safe' ? t('安全缓存') : e.category === 'stateful' ? t('历史日志') : escapeHtml(e.category)}</td>
        <td>${fmtBytes(e.bytes)}</td>
        <td>${fmtTokens(e.fileCount)}</td>
      </tr>`).join('')}
    </tbody></table>
    <div style="display:flex;gap:12px;align-items:center;margin-top:12px;">
      <button class="btn primary" id="st-clear">${t('清理所选')}</button>
      <span style="font-size:12px;color:var(--fg-muted);">${t('回收仓:')}${escapeHtml(scan.trashDir ?? '')}${scan.usingFallbackTrash ? ' · ' + (langIsEn() ? 'fallback local' : '已回退本地') : ''}</span>
    </div>
    ${snapshots.length ? `<h2 style="margin-top:20px;">${t('清理快照')}</h2>${stSnapshotTable(snapshots)}` : ''}
  `;
  const clearBtn = el('st-clear');
  if (clearBtn) clearBtn.onclick = () => runWithSpinner('st-clear', async () => {
    const names = [...root.querySelectorAll('.st-item:checked')].map(c => c.dataset.name);
    if (!names.length) throw new Error(t('请至少勾选一个要清理的项目'));
    const totalBytes = entries.filter(e => names.includes(e.name)).reduce((n, e) => n + (e.bytes ?? 0), 0);
    if (!window.confirm(`${t('将把')}${names.length} ${t('个项目(共')}${fmtBytes(totalBytes)})${t(')移入回收仓快照,随时可恢复。\n请确认已退出 Antigravity。继续?')}`)) return;
    const result = await invoke('maintenance_clear', { token: scan.token, names });
    stFlash(`${langIsEn() ? 'Cleaned' : '已清理'} ${fmtBytes(result.clearedBytes)} · ${result.moved} ${langIsEn() ? 'item(s) · snapshot ' : '个项目 · 快照 '}${result.snapshotId || '—'}${langIsEn() ? ' (restorable below)' : '(可在下方恢复)'}`);
    await renderStorageScan();
  });
  for (const btn of root.querySelectorAll('.st-restore')) {
    btn.onclick = () => runWithSpinner(`st-restore-${btn.dataset.id}`, async () => {
      if (!window.confirm(t('将把该快照中的缓存原样放回 Antigravity 数据目录。\n请确认已退出 Antigravity。继续?'))) return;
      const r = await invoke('maintenance_restore', { snapshotId: btn.dataset.id });
      stFlash(r.message || `${langIsEn() ? 'Restored snapshot ' : '已恢复快照 '}${btn.dataset.id}`);
      await renderStorageScan();
    });
  }
}

function stFlash(text) {
  const box = document.createElement('div');
  box.className = 'success-box';
  box.textContent = text;
  el('page-storage').prepend(box);
  setTimeout(() => box.remove(), 15000);
}

/* ---------------- Settings ---------------- */

async function renderSettings() {
  const root = el('page-settings');
  const cfg = state.config ?? {};
  let hud = { mode: 'off', message: '', windows: 0, hudEnabled: false };
  try { hud = await invoke('hud_status'); } catch { /* 服务未启动时展示离线态 */ }
  const hudModeText = {
    'connected': langIsEn() ? 'Injected into Antigravity' : '已注入 Antigravity',
    'waiting': langIsEn() ? 'Waiting for Antigravity' : '等待 Antigravity 启动',
    'waiting-window': langIsEn() ? 'Waiting for window' : '等待应用窗口就绪',
    'debug-port-missing': langIsEn() ? 'Antigravity runs without debug port' : 'Antigravity 未带调试端口运行',
    'legacy-blocked': langIsEn() ? 'Third-party patch detected — injection disabled' : '检测到第三方补丁(legacyPatch),注入已停用',
    'paused': langIsEn() ? 'Paused' : '已暂停',
    'starting': langIsEn() ? 'Starting…' : '启动中…',
    'off': langIsEn() ? 'Not started' : '未启动',
  }[hud.mode] ?? hud.mode;
  const quotaInterval = Number(cfg.quotaRefreshIntervalMinutes ?? 0);
  root.innerHTML = `
    <h1>${t('设置')}</h1>
    <p class="page-sub">${t('AntigravityBox 偏好 · 立即生效')}</p>
    <div class="card">
      <div class="setting-row">
        <div class="info"><div class="title">${t('Antigravity 界面汉化')}</div>
        <div class="desc">${escapeHtml(hudModeText)}${hud.windows ? ` · ${hud.windows} ${langIsEn() ? 'window(s)' : '个窗口'}` : ''}${hud.message ? ` — ${escapeHtml(hud.message)}` : ''}</div></div>
        <label class="switch"><input type="checkbox" id="cfg-hud" ${hud.hudEnabled ? 'checked' : ''} /><span class="slider"></span></label>
      </div>
      <div class="setting-row">
        <div class="info"><div class="title">${t('重新注入')}</div><div class="desc">${t('在 Antigravity 界面上重新应用翻译与 HUD 状态栏')}</div></div>
        <button class="btn small" id="cfg-reapply">${t('执行')}</button>
      </div>
      ${hud.mode === 'debug-port-missing' ? `
      <div class="setting-row">
        <div class="info"><div class="title">${t('以 HUD 模式重启 Antigravity')}</div><div class="desc">${t('温和请求退出 Antigravity,并带调试参数重新打开(请先保存未保存的工作)')}</div></div>
        <button class="btn small primary" id="cfg-relaunch">${t('重启…')}</button>
      </div>` : ''}
      <div class="setting-row">
        <div class="info"><div class="title">${t('Antigravity 界面语言')}</div><div class="desc">${t('翻译引擎把英文界面按此目标语言汉化(英文 = 关闭翻译)')}</div></div>
        <select id="cfg-app-language">
          <option value="system">${t('跟随系统')}</option>
          <option value="zh-Hans">${t('简体中文')}</option>
          <option value="en">${t('关闭翻译(English)')}</option>
        </select>
      </div>
      <div class="setting-row">
        <div class="info"><div class="title">${t('显示语言')}</div><div class="desc">${t('AntigravityBox 自身界面语言')}</div></div>
        <select id="cfg-language">
          <option value="system">${t('跟随系统')}</option>
          <option value="zh-Hans">${t('简体中文')}</option>
          <option value="en">${t('English')}</option>
        </select>
      </div>
      <div class="setting-row">
        <div class="info"><div class="title">${t('显示主题')}</div><div class="desc">${t('跟随系统浅色/深色,或固定一种;托盘面板同步')}</div></div>
        <select id="cfg-theme">
          <option value="system">${t('跟随系统')}</option>
          <option value="light">${t('浅色')}</option>
          <option value="dark">${t('深色')}</option>
        </select>
      </div>
      <div class="setting-row">
        <div class="info"><div class="title">${t('系统通知')}</div><div class="desc">${t('配额接近阈值换号提醒、新版本提醒;点击通知打开主界面')}</div></div>
        <label class="switch"><input type="checkbox" id="cfg-notify" ${cfg.notificationsEnabled !== false ? 'checked' : ''} /><span class="slider"></span></label>
      </div>
      <div class="setting-row">
        <div class="info"><div class="title">${t('全局快捷键呼出面板')}</div><div class="desc">${t('Ctrl+Shift+B 随时呼出/隐藏快捷面板;Ctrl+, 打开主界面,Ctrl+Q 退出')}</div></div>
        <label class="switch"><input type="checkbox" id="cfg-hotkey" ${cfg.hotkeyEnabled !== false ? 'checked' : ''} /><span class="slider"></span></label>
      </div>
      <div class="setting-row">
        <div class="info"><div class="title">${t('配额刷新间隔')}</div><div class="desc">${t('后台定时刷新已保存账号的配额;单账号保持手动即可')}</div></div>
        <select id="cfg-quota-interval">
          <option value="0" ${quotaInterval === 0 ? 'selected' : ''}>${t('手动刷新')}</option>
          <option value="5" ${quotaInterval === 5 ? 'selected' : ''}>${t('每 5 分钟')}</option>
          <option value="10" ${quotaInterval === 10 ? 'selected' : ''}>${t('每 10 分钟')}</option>
          <option value="15" ${quotaInterval === 15 ? 'selected' : ''}>${t('每 15 分钟')}</option>
          <option value="30" ${quotaInterval === 30 ? 'selected' : ''}>${t('每 30 分钟')}</option>
          <option value="60" ${quotaInterval === 60 ? 'selected' : ''}>${t('每 60 分钟')}</option>
        </select>
      </div>
      <div class="setting-row">
        <div class="info"><div class="title">${t('跟随 Antigravity 启停')}</div><div class="desc">${t('Antigravity 退出后自动退出本应用,不留下多余后台图标')}</div></div>
        <label class="switch"><input type="checkbox" id="cfg-follow" ${cfg.followAntigravity ? 'checked' : ''} /><span class="slider"></span></label>
      </div>
      <div class="setting-row">
        <div class="info"><div class="title">${t('登录时启动')}</div><div class="desc">${t('开机后在系统托盘静默待命')}</div></div>
        <label class="switch"><input type="checkbox" id="cfg-autostart" /><span class="slider"></span></label>
      </div>
      <div class="setting-row">
        <div class="info"><div class="title">${t('自动同步价格基准')}</div><div class="desc">${t('每 24 小时从远端同步一次公开模型单价(默认关)')}</div></div>
        <label class="switch"><input type="checkbox" id="cfg-pricing" /><span class="slider"></span></label>
      </div>
      <div class="setting-row">
        <div class="info"><div class="title">${t('数据目录')}</div><div class="desc">${escapeHtml(state.status?.stateDir ?? '')}</div></div>
        <button class="btn small" id="cfg-reveal">${t('打开')}</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head-row">
        <h2>${t('个人词典')}</h2>
        <span style="font-size:12px;color:var(--fg-muted)">${t('英文原文 → 中文译文;保存后 HUD 词典自动重载,必要时点「重新注入」立即应用')}</span>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <input type="text" id="pd-key" placeholder="${t('英文原文(界面上的英文文本)')}" style="flex:1" />
        <input type="text" id="pd-value" placeholder="${t('译文')}" style="flex:1" />
        <button class="btn primary small" id="pd-add">${t('添加')}</button>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center;">
        <input type="text" id="pd-search" placeholder="${t('搜索词条…')}" style="width:240px" />
        <span id="pd-count" style="font-size:12px;color:var(--fg-muted)"></span>
      </div>
      <div id="pd-list"></div>
    </div>`;
  const hudSwitch = el('cfg-hud');
  hudSwitch.onchange = async () => {
    hudSwitch.disabled = true;
    try { await invoke('hud_set', { enabled: hudSwitch.checked }); }
    catch (e) { alert(`${t('切换失败:')}${e.message}`); hudSwitch.checked = !hudSwitch.checked; }
    hudSwitch.disabled = false;
  };
  el('cfg-reapply').onclick = async () => {
    await runWithSpinner('cfg-reapply', async () => { await invoke('reapply'); });
    await renderSettings();
  };
  const relaunch = el('cfg-relaunch');
  if (relaunch) relaunch.onclick = () => {
    const ok = window.confirm(t('将以 HUD 模式重启 Antigravity。\n\n请先保存 Antigravity 中未保存的工作;确认后将温和请求 Antigravity 退出,并带调试参数重新打开。'));
    if (!ok) return;
    void (async () => {
      try {
        const result = await invoke('hud_safe_relaunch');
        if (result?.ok === false) alert(`${t('未能自动重启:')}${result.phase === 'quit-timeout' ? t('未能在时限内退出(未强制关闭)') : t('启动失败')}${t('。请手动退出后从本面板重新打开。')}`);
      } catch (e) { alert(`${t('重启失败:')}${e.message}`); }
      await renderSettings();
    })();
  };
  const appLang = el('cfg-app-language');
  // Antigravity 界面语言偏好存于 runtime-preferences(controller status.configuredLanguage 投影)。
  appLang.value = hud.configuredLanguage ?? 'system';
  appLang.onchange = async () => {
    await runWithSpinner('cfg-app-language', async () => {
      await invoke('language_set', { language: appLang.value });
    });
  };
  const lang = el('cfg-language');
  lang.value = cfg.language ?? 'system';
  lang.onchange = async () => {
    await invoke('config_set', { patch: { language: lang.value } });
    state.config = await invoke('config_get');
    setLanguage(state.config.language);
    translateShell();
    await renderActive();
  };
  const quotaIntervalSel = el('cfg-quota-interval');
  quotaIntervalSel.onchange = async () => {
    await invoke('config_set', { patch: { quotaRefreshIntervalMinutes: Number(quotaIntervalSel.value) } });
    state.config = await invoke('config_get');
  };
  const follow = el('cfg-follow');
  follow.onchange = async () => {
    await invoke('config_set', { patch: { followAntigravity: follow.checked } });
    state.config = await invoke('config_get');
  };
  const theme = el('cfg-theme');
  theme.value = cfg.themeMode ?? 'system';
  theme.onchange = async () => {
    await invoke('config_set', { patch: { themeMode: theme.value } });
    state.config = await invoke('config_get');
  };
  const notifyToggle = el('cfg-notify');
  notifyToggle.onchange = async () => {
    await invoke('config_set', { patch: { notificationsEnabled: notifyToggle.checked } });
    state.config = await invoke('config_get');
  };
  const hotkey = el('cfg-hotkey');
  hotkey.onchange = async () => {
    await invoke('config_set', { patch: { hotkeyEnabled: hotkey.checked } });
    state.config = await invoke('config_get');
  };
  const autostart = el('cfg-autostart');
  autostart.checked = Boolean(await window.agbox.getAutostart());
  autostart.onchange = async () => {
    await window.agbox.setAutostart(autostart.checked);
  };
  const pricing = el('cfg-pricing');
  pricing.checked = cfg.autoRemotePricingSync === true;
  pricing.onchange = async () => {
    await invoke('config_set', { patch: { autoRemotePricingSync: pricing.checked } });
  };
  el('cfg-reveal').onclick = () => window.agbox.revealPath(state.status?.stateDir ?? '');
  el('pd-add').onclick = () => runWithSpinner('pd-add', async () => {
    const key = el('pd-key').value.trim();
    const value = el('pd-value').value;
    if (!key || !value.trim()) throw new Error(t('请填写英文原文与译文'));
    const current = (await invoke('dict_personal_get')).entries ?? {};
    await invoke('dict_personal_save', { entries: { ...current, [key]: value } });
    el('pd-key').value = '';
    el('pd-value').value = '';
    await renderPersonalDict();
  });
  el('pd-search').addEventListener('input', () => renderPdList());
  await renderPersonalDict();
}

/* ---- 个人词典(个人覆盖.json 三层词典的最高层) ---- */

let pdEntries = {};

async function renderPersonalDict() {
  const res = await invoke('dict_personal_get');
  pdEntries = res.entries ?? {};
  el('pd-count').textContent = `${res.count} ${t('条词条')}`;
  renderPdList();
}

function renderPdList() {
  const box = el('pd-list');
  if (!box) return;
  const q = (el('pd-search')?.value ?? '').trim().toLowerCase();
  const keys = Object.keys(pdEntries)
    .filter(k => !q || k.toLowerCase().includes(q) || String(pdEntries[k]).toLowerCase().includes(q))
    .slice(0, 100);
  if (!keys.length) {
    box.innerHTML = `<div class="empty">${q ? t('没有匹配的词条') : t('暂无个人词条 — 上方添加后立即生效')}</div>`;
    return;
  }
  box.innerHTML = `<table><thead><tr><th>${t('英文原文')}</th><th>${t('译文')}</th><th style="width:70px"></th></tr></thead><tbody>
    ${keys.map(k => `<tr>
      <td class="mono" style="max-width:360px;overflow-wrap:anywhere">${escapeHtml(k)}</td>
      <td style="max-width:360px;overflow-wrap:anywhere">${escapeHtml(pdEntries[k])}</td>
      <td><button class="btn small pd-del" data-key="${escapeHtml(k)}">${t('删除')}</button></td>
    </tr>`).join('')}
  </tbody></table>
  ${Object.keys(pdEntries).length > 100 ? `<div class="empty">${t('仅显示前')} 100 ${t('条,请用搜索缩小范围')}</div>` : ''}`;
  for (const btn of box.querySelectorAll('.pd-del')) {
    btn.onclick = () => runWithSpinner(null, async () => {
      const next = { ...pdEntries };
      delete next[btn.dataset.key];
      await invoke('dict_personal_save', { entries: next });
      await renderPersonalDict();
    });
  }
}

/* ---------------- About ---------------- */

const updateState = { lastCheck: null, downloaded: null };

async function renderAbout() {
  const root = el('page-about');
  let boxVersion = '';
  try { boxVersion = (await invoke('box_version')).version ?? ''; } catch { /* 老版本无此命令 */ }
  const cfg = state.config ?? {};
  const up = updateState.lastCheck;
  root.innerHTML = `
    <h1>${t('关于')}</h1>
    <p class="page-sub">AntigravityBox v${escapeHtml(boxVersion || '0.1.0')}</p>
    <div class="card">
      <table>
        <tr><td>${t('检测到的 Antigravity 版本')}</td><td>${escapeHtml(state.status?.appVersion ?? t('未知'))}</td></tr>
        <tr><td>${t('应用架构')}</td><td>${escapeHtml(state.status?.appArchitecture ?? '')}</td></tr>
        <tr><td>${t('Antigravity 安装目录')}</td><td>${escapeHtml(state.status?.appPath ?? '')}</td></tr>
        <tr><td>${t('Antigravity 数据目录')}</td><td>${escapeHtml(state.status?.profile ?? '')}</td></tr>
        <tr><td>${t('会话数据目录')}</td><td>${escapeHtml(state.status?.geminiDir ?? '')}</td></tr>
        <tr><td>${t('OAuth 客户端')}</td><td>${state.status?.oauthClientConfigured ? t('已配置(支持后台静默续期)') : t('未配置(不影响日常使用)')}</td></tr>
      </table>
    </div>
    <div class="card">
      <h2>${t('检查更新')}</h2>
      <div class="setting-row" style="border-bottom:none;">
        <div class="info">
          <div class="title" id="up-status">${up ? describeUpdateStatus(up) : (cfg.updateRepo ? t('尚未检查') : t('更新源(GitHub 仓库)') + ': —')}</div>
          <div class="desc" id="up-notes">${up?.notes ? escapeHtml(up.notes) : escapeHtml(t('自动检查更新') + ': ' + (cfg.updateAutoCheck ? langIsEn() ? 'on' : '开' : langIsEn() ? 'off' : '关'))}</div>
        </div>
        <div class="actions" style="display:flex;gap:8px;">
          ${updateState.downloaded?.ok ? `<button class="btn primary" id="up-install">${t('安装更新')}</button>` : ''}
          ${up?.status === 'available' && !updateState.downloaded?.ok ? `<button class="btn primary" id="up-download">${t('下载并校验…')}</button>` : ''}
          <button class="btn" id="up-check">${t('检查更新')}</button>
        </div>
      </div>
      <div class="setting-row">
        <div class="info"><div class="title">${t('自动检查更新')}</div><div class="desc">${t('每 24 小时静默检查一次新版本(默认关,保持零打扰)')}</div></div>
        <label class="switch"><input type="checkbox" id="cfg-upd-auto" ${cfg.updateAutoCheck ? 'checked' : ''} /><span class="slider"></span></label>
      </div>
      <div class="setting-row">
        <div class="info"><div class="title">${t('更新源(GitHub 仓库)')}</div><div class="desc">${t('例如 owner/repo;发布 AntigravityBox-Setup-*-x64.exe 与 .sha256 的仓库')}</div></div>
        <input type="text" id="cfg-upd-repo" value="${escapeHtml(cfg.updateRepo ?? '')}" placeholder="owner/repo" style="width:220px" />
      </div>
    </div>
    <div class="card">
      <h2>${t('致谢')}</h2>
      <div style="font-size:13px;color:var(--fg-muted);line-height:1.8;">
        ${langIsEn()
          ? 'This project is a port of <a href="#" data-link="https://github.com/Enzoo404/gravitybox">Enzoo404/gravitybox</a> (MIT License), reimplemented for the Windows platform. Not affiliated with Google / Antigravity.'
          : '本项目基于 <a href="#" data-link="https://github.com/Enzoo404/gravitybox">Enzoo404/gravitybox</a>(MIT License)的架构与核心逻辑移植,针对 Windows 平台重新实现桌面壳与平台适配层。与 Google / Antigravity 官方无任何从属关系。'}
      </div>
    </div>`;
  for (const a of root.querySelectorAll('[data-link]')) {
    a.onclick = (e) => { e.preventDefault(); window.agbox.openExternal(a.dataset.link); };
  }
  el('up-check').onclick = () => runWithSpinner('up-check', async () => {
    updateState.lastCheck = await invoke('update_check');
    await renderAbout();
  });
  const dl = el('up-download');
  if (dl) dl.onclick = () => runWithSpinner('up-download', async () => {
    updateState.downloaded = await invoke('update_download');
    if (!updateState.downloaded.ok) throw new Error(updateState.downloaded.error ?? 'download failed');
    await renderAbout();
  });
  const inst = el('up-install');
  if (inst) inst.onclick = () => runWithSpinner('up-install', async () => {
    const r = await invoke('update_install');
    if (!r.ok) throw new Error(r.error ?? 'install failed');
  });
  const updAuto = el('cfg-upd-auto');
  updAuto.onchange = async () => {
    await invoke('config_set', { patch: { updateAutoCheck: updAuto.checked } });
    state.config = await invoke('config_get');
  };
  const updRepo = el('cfg-upd-repo');
  let repoTimer = null;
  updRepo.oninput = () => {
    clearTimeout(repoTimer);
    repoTimer = setTimeout(async () => {
      await invoke('config_set', { patch: { updateRepo: updRepo.value.trim() } });
      state.config = await invoke('config_get');
    }, 600);
  };
}

function describeUpdateStatus(up) {
  if (up.status === 'available') return `${t('发现新版本')}: v${up.latestVersion ?? ''}`;
  if (up.status === 'up-to-date') return t('当前已是最新版本');
  if (up.status === 'no-repo') return langIsEn() ? 'Update source not configured' : '未配置更新源';
  if (up.status === 'no-asset') return langIsEn() ? 'No Windows installer in latest release' : '最新 Release 无 Windows 安装包';
  return langIsEn() ? 'Update check failed' : '检查更新失败';
}

/* ---------------- helpers ---------------- */

async function runWithSpinner(_btnId, fn) {
  try {
    await fn();
  } catch (error) {
    const box = document.createElement('div');
    box.className = 'error-box';
    box.textContent = `${t('操作失败:')}${error.message}`;
    document.querySelector('.page.active')?.prepend(box);
    setTimeout(() => box.remove(), 6000);
  }
}

async function refreshAccounts() {
  state.accounts = await invoke('account_list');
  el('conn-info').textContent = state.accounts.identityState === 'verified'
    ? `${t('已连接')} · ${state.accounts.activeId ?? ''}`
    : t('Antigravity 未运行或未登录');
}

async function refreshUsage() {
  state.usage = (await invoke('usage_summary', { force: false })).summary;
}

/** 侧栏与标题的静态文本随显示语言刷新。 */
function translateShell() {
  document.title = 'AntigravityBox';
  const navMap = { overview: '总览', accounts: '账号', usage: '用量', conversations: '会话库', storage: '存储', settings: '设置', about: '关于' };
  for (const btn of document.querySelectorAll('.nav-item')) {
    const span = btn.querySelector('span');
    if (span) span.textContent = t(navMap[btn.dataset.target] ?? btn.dataset.target);
  }
}

async function boot() {
  try {
    state.status = (await invoke('status')).status;
    state.config = await invoke('config_get');
  } catch (error) {
    el('conn-info').textContent = `${t('后端错误:')}${error.message}`;
  }
  setLanguage(state.config?.language ?? 'system');
  translateShell();
  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.onclick = async () => {
      showPage(btn.dataset.target);
      await renderActive();
    };
  }
  try {
    await Promise.all([refreshAccounts(), refreshUsage(), refreshRecommend()]);
  } catch { /* first run with no data */ }
  // HUD 引擎状态:即时拉取 + 订阅主进程推送(状态变更无需轮询)。
  try {
    state.hudStatus = await invoke('hud_status');
    window.agbox.onHudStatus?.(status => {
      state.hudStatus = status;
      if (document.body.dataset.currentPage === 'overview') void renderOverview();
    });
  } catch { /* HUD 服务未启动 */ }
  showPage('overview');
  await renderOverview();

  // periodic refresh of status + accounts (lightweight)
  setInterval(async () => {
    try {
      await refreshAccounts();
      if (document.body.dataset.currentPage === 'overview') await renderOverview();
    } catch { /* transient */ }
  }, 30_000);
}

async function renderActive() {
  const page = document.body.dataset.currentPage;
  if (page === 'overview') await renderOverview();
  else if (page === 'accounts') await renderAccounts();
  else if (page === 'usage') await renderUsage();
  else if (page === 'conversations') await renderConversations();
  else if (page === 'storage') await renderStorage();
  else if (page === 'settings') await renderSettings();
  else if (page === 'about') await renderAbout();
}

boot();
