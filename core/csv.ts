// AntigravityBox — CSV serialization for usage exports (Excel-friendly, RFC 4180).
// 渲染层与单测共用同一实现;BOM 由调用方按需添加(Excel 需要 \uFEFF 才能识别 UTF-8)。

function csvField(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  // 引号包裹 + 内部双引号翻倍;前导 =/+/-/@ 防止 Excel 公式注入。
  if (/[",\r\n]/.test(s) || /^[=+\-@\t\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(csvField).join(',')];
  for (const row of rows) lines.push(row.map(csvField).join(','));
  return lines.join('\r\n') + '\r\n';
}

export interface UsageEventRow {
  timestamp_seconds?: number;
  model?: string;
  input_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  estimated_usd?: number;
  priced?: boolean;
  account_email?: string;
}

const EVENT_HEADERS = ['时间', '账号', '模型', '输入', '缓存读取', '缓存写入', '输出', '总计', '费用估算USD', '已计价'];

/** 请求明细 → CSV(含 BOM,Excel 直接打开不乱码)。 */
export function usageEventsCsv(rows: UsageEventRow[]): string {
  const body = toCsv(EVENT_HEADERS, rows.map(r => [
    r.timestamp_seconds ? new Date(r.timestamp_seconds < 1e11 ? r.timestamp_seconds * 1000 : r.timestamp_seconds).toLocaleString() : '',
    r.account_email ?? '',
    r.model ?? '',
    r.input_tokens ?? 0,
    r.cached_tokens ?? 0,
    r.cache_write_tokens ?? 0,
    r.output_tokens ?? 0,
    r.total_tokens ?? 0,
    r.estimated_usd ?? 0,
    r.priced === false ? '0' : '1',
  ]));
  return '\uFEFF' + body;
}

/**
 * 成本预测:按近 7 天费用线性外推 30 天月费用。
 * 7 天数据不足(少于 1 天)时返回 null,避免拿 0 误报。
 */
export function projectMonthlyCost(cost7d: number | undefined, days = 7, horizonDays = 30): number | null {
  if (!Number.isFinite(cost7d) || (cost7d ?? 0) <= 0 || days <= 0) return null;
  return Math.round(((cost7d as number) / days * horizonDays) * 100) / 100;
}
