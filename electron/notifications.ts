/**
 * AntigravityBox — Windows system notifications (Electron Notification).
 * 上游语义:智能切换开启且监测配额 ≤ 阈值时"发出换号提醒";更新静默检查发现新版本时温和提示。
 * 主进程独占 Notification;渲染层不感知。设置里 notificationsEnabled=false 时全部静默。
 */
import { Notification } from 'electron';
import { Backend } from './backend.js';

export interface NotifyDeps {
  /** 通知点击后的跳转动作(如打开主界面)。 */
  onActivate?: () => void;
  /** 读取当前通知总开关。 */
  enabled: () => boolean;
}

/** 单实例通知门面:同一事件在一次会话内不重复轰炸。 */
class NotificationGate {
  private lastFired = new Map<string, number>();
  fire(key: string, cooldownMs: number, show: () => void): boolean {
    const now = Date.now();
    const last = this.lastFired.get(key) ?? 0;
    if (now - last < cooldownMs) return false;
    this.lastFired.set(key, now);
    show();
    return true;
  }
  /** 清除某键的冷却(配额恢复健康后重新布防)。 */
  clear(key: string): void { this.lastFired.delete(key); }
}

function showNotification(deps: NotifyDeps, title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title,
    body,
    silent: false,
  });
  notification.on('click', () => {
    try { deps.onActivate?.(); } catch { /* 窗口创建失败不致命 */ }
  });
  notification.show();
}

const quotaGate = new NotificationGate();
const updateGate = new NotificationGate();

/**
 * 配额阈值提醒:复用 auto_switch_recommend 的同一套融合配额/阈值语义。
 * 每个"账号"触发一次后冷却 30 分钟;恢复到阈值以上时清除冷却重新布防。
 */
export async function checkQuotaThresholdNotification(backend: Backend, deps: NotifyDeps): Promise<boolean> {
  if (!deps.enabled()) return false;
  try {
    const recommend = await backend.autoSwitchRecommend();
    if (!recommend.enabled || !Number.isFinite(recommend.currentRemaining)) return false;
    const cfg = await backend.accountsManager.getAutoSwitchConfig();
    const remaining = recommend.currentRemaining as number;
    const threshold = cfg.reserve_percentage;
    if (remaining > threshold) {
      // 健康:清掉该账号的冷却,下次跌落立即提醒
      quotaGate.clear(`low:${recommend.currentEmail}`);
      return false;
    }
    // 同一下跌周期内最多提醒一次(30 分钟冷却)
    return quotaGate.fire(`low:${recommend.currentEmail}`, 30 * 60_000, () => {
      const candidate = recommend.bestCandidate
        ? `。建议切换到 ${recommend.bestCandidate.email}(${recommend.bestCandidate.remaining}%)`
        : '。没有达到准入线的备用账号';
      showNotification(
        deps,
        '配额接近阈值',
        `${recommend.currentEmail} 的监测配额仅剩 ${Math.round(remaining)}%${candidate}`,
      );
    });
  } catch { /* 推荐服务暂不可用:静默,下轮再试 */ }
  return false;
}

/** 更新提醒:每个版本号只提醒一次。 */
export function notifyUpdateAvailable(deps: NotifyDeps, latestVersion: string): boolean {
  if (!deps.enabled()) return false;
  return updateGate.fire(`update:${latestVersion}`, Number.POSITIVE_INFINITY, () => {
    showNotification(deps, 'AntigravityBox 有新版本', `v${latestVersion} 已发布 — 可在「关于」页下载并校验后安装。`);
  });
}
