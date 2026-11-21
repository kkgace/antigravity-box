// AntigravityBox — shared renderer helpers.
export async function invoke(command, payload = {}) {
  const result = await window.agbox.invoke(command, payload);
  if (!result || result.ok !== true) {
    const err = new Error(result?.error || 'unknown error');
    err.payload = result;
    throw err;
  }
  return result;
}

export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function fmtUsd(n) {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  if (n < 0.01) return `~$${n.toFixed(4)}`;
  return `~$${n.toFixed(2)}`;
}

export function fmtPct(remaining, known = true) {
  if (!Number.isFinite(remaining)) return known ? '—' : '~—';
  const v = Math.round(remaining * 100);
  return `${known ? '' : '~'}${v}%`;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(typeof ts === 'number' && ts < 1e11 ? ts * 1000 : ts);
  return isNaN(d) ? String(ts) : d.toLocaleString();
}

export function barClass(remaining) {
  if (!Number.isFinite(remaining)) return '';
  if (remaining <= 0.1) return 'bad';
  if (remaining <= 0.3) return 'warn';
  return 'good';
}

export function tierBadge(tier) {
  const t = String(tier || '').toUpperCase();
  if (!t) return '';
  const cls = t.includes('ULTRA') ? 'ultra' : t.includes('PRO') ? 'pro' : t === 'FREE' ? 'free' : '';
  return `<span class="badge ${cls}">${escapeHtml(t)}</span>`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function showPage(name) {
  for (const el of document.querySelectorAll('.page')) el.classList.toggle('active', el.dataset.page === name);
  for (const btn of document.querySelectorAll('.nav-item')) btn.classList.toggle('active', btn.dataset.target === name);
  const state = document.body.dataset;
  state.currentPage = name;
}
