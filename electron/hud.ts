/**
 * AntigravityBox — HUD / 汉化引擎服务(Electron 主进程)。
 * 对应上游 main.ts 的 Controller 接线:词典分层加载 + 运行时偏好持久化 + CDP 注入控制器。
 * 零修改原则:只通过 CDP Isolated World 注入,绝不改写 Antigravity 安装文件。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { Controller } from '../core/controller.js';
import { DictionaryStore, resolveDictionaryForLocale } from '../core/dictionary.js';
import type { Dictionary } from '../core/dictionary.js';
import { setActiveLocale } from '../core/i18n.js';
import { applicationTarget } from '../core/application-target.js';
import { stateDir } from '../windows/paths.js';
import { atomicJson } from '../core/files.js';
import { sanitizeError } from '../core/files.js';

const here = dirname(fileURLToPath(import.meta.url));
// 词典目录候选(按序探测):asar 打包后 fs.watch 不支持 asar 内路径,dict 经 asarUnpack
// 落在 app.asar.unpacked/dist/dict(真实文件系统,可监听热更新),必须先于 asar 路径探测;
// dev 树无 unpacked 目录,自然回退 dist/dict。
const dictBaseCandidates = [
  // here = <asar>/dist/electron → 三级上级到 resources/,unpacked 与 app.asar 平级。
  join(here, '..', '..', '..', 'app.asar.unpacked', 'dist', 'dict'),
  join(here, '..', 'dict'),
  join(here, '..', '..', 'dict'),
];

export interface HudRuntimePreferences {
  language?: string;
  translationEnabled?: boolean;
  hudEnabled?: boolean;
}

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as T : undefined;
  } catch {
    return undefined;
  }
}

export class HudService {
  private controller?: Controller;
  private store?: DictionaryStore;
  private dir?: string;
  private started = false;
  private lastStatus?: Record<string, unknown>;

  constructor(
    private appPath: string,
    private profile: string,
    private geminiDir: string,
    private dirs: string,
    private onStatus?: (status: Record<string, unknown>) => void,
  ) {}

  /** 上游 onStatus 语义:状态快照广播给主窗口/托盘;渲染层据此展示连接模式。 */
  private handleStatus = (status: Record<string, unknown>) => {
    this.lastStatus = { ...status };
    try { this.onStatus?.(this.lastStatus); } catch { /* 广播失败不阻断控制器 */ }
  };

  private async resolveDictBase(): Promise<string> {
    for (const candidate of dictBaseCandidates) {
      try {
        await readFile(join(candidate, 'base.json'), 'utf8');
        return candidate;
      } catch { /* 尝试下一个 */ }
    }
    throw new Error('未找到词典目录 dict/base.json — 请先运行 npm run build');
  }

  private async loadPreferences(): Promise<HudRuntimePreferences> {
    return (await readOptionalJson<HudRuntimePreferences>(join(this.dirs, 'runtime-preferences.json'))) ?? {};
  }

  private async savePreferences(patch: HudRuntimePreferences): Promise<void> {
    const current = await this.loadPreferences();
    await atomicJson(join(this.dirs, 'runtime-preferences.json'), { ...current, ...patch });
    // 同步 Antigravity 侧可见的全局配置(与上游 config.json 对齐,尽力而为)。
    const configPath = join(this.dirs, 'config.json');
    const cfg = await readOptionalJson<Record<string, unknown>>(configPath);
    if (cfg && (cfg.schema === undefined || cfg.schema === 2)) {
      await atomicJson(configPath, {
        ...cfg,
        ...(typeof patch.hudEnabled === 'boolean' ? { hudEnabled: patch.hudEnabled } : {}),
        ...(typeof patch.language === 'string' ? { appLanguage: patch.language } : {}),
      }).catch(() => {});
    }
  }

  async start(): Promise<Record<string, unknown>> {
    if (this.started) return this.status();
    const baseDir = await this.resolveDictBase();
    await mkdir(this.dirs, { recursive: true });
    const prefs = await this.loadPreferences();
    const requested = typeof prefs.language === 'string' && prefs.language ? prefs.language : 'system';
    const { resolveLocale } = await import('../core/i18n.js');
    // 本仓 i18n.resolveLocale 返回 locale 字符串('system' 按系统语言解析),非上游的对象返回值。
    const resolvedLocale = resolveLocale(requested);
    setActiveLocale(resolvedLocale);
    const initialDictInfo = await resolveDictionaryForLocale(baseDir, resolvedLocale);

    const store = new DictionaryStore(initialDictInfo.baseDir, join(this.dirs, 'dictionary'));
    // 用户词典层目录由本服务负责创建(增量补全/个人覆盖写入时需要)。
    await mkdir(join(this.dirs, 'dictionary'), { recursive: true });
    await store.start();
    if (!store.current) {
      // 损坏词典时不阻断启动:controller 以空词典等待,事件通道随后恢复。
      store.current = { version: 'base', entries: {}, templateRules: [] } as unknown as Dictionary;
    }
    this.store = store;
    this.dir = this.dirs;

    const controller = new Controller({
      appPath: this.appPath,
      profile: this.profile,
      geminiDir: this.geminiDir,
      stateDir: this.dirs,
      dictionary: store.current,
      hasTargetDictionary: resolvedLocale !== 'en' && initialDictInfo.hasTargetDictionary,
      locale: resolvedLocale,
      configuredLanguage: requested,
      hudEnabled: prefs.hudEnabled !== false,
      shortcutEnabled: true,
      selectDictionary: async (version: string) => {
        const dictionary = await store.selectVersion(version);
        return dictionary;
      },
      reloadDictionary: async () => {
        await store.reload();
        if (store.lastError) throw new Error(store.lastError);
      },
      onStatus: this.handleStatus,
    });
    this.controller = controller;
    store.on('updated', dictionary => { void controller.update(dictionary); });
    store.on('invalid', message => controller.dictionaryError(String(message)));
    store.on('valid', () => controller.dictionaryError());
    if (store.lastError) controller.dictionaryError(store.lastError);
    await controller.start();
    this.started = true;
    return this.status();
  }

  async status(): Promise<Record<string, unknown>> {
    const snap = this.controller?.snapshot();
    return (snap as unknown as Record<string, unknown>) ?? this.lastStatus
      ?? { mode: this.started ? 'starting' : 'off', message: '', windows: 0, locale: 'zh-Hans' };
  }

  /** HUD 开关(上游 hud_set)。 */
  async setHudEnabled(enabled: boolean): Promise<Record<string, unknown>> {
    if (!this.controller) throw new Error('HUD 服务尚未启动');
    await this.controller.configureHud(enabled);
    await this.savePreferences({ hudEnabled: enabled });
    return this.status();
  }

  /** 重新应用注入(上游 reapply/resume)。 */
  async reapply(): Promise<Record<string, unknown>> {
    if (!this.controller) throw new Error('HUD 服务尚未启动');
    await this.controller.resume();
    await this.controller.sync();
    return this.status();
  }

  /** 语言切换(上游 language_set):解析 locale → 词典链 → 控制器。返回是否启用翻译。 */
  async setLanguage(requested: string): Promise<{ translationEnabled: boolean; locale: string }> {
    if (!this.controller || !this.store) throw new Error('HUD 服务尚未启动');
    const target = (requested || 'system').trim();
    const { resolveLocale } = await import('../core/i18n.js');
    const resolvedLocale = resolveLocale(target === '' ? 'system' : target);
    setActiveLocale(resolvedLocale);
    const baseDir = this.store.baseDir;
    const nextDictInfo = await resolveDictionaryForLocale(baseDir, resolvedLocale);
    if (nextDictInfo.baseDir !== baseDir) await this.store.setBaseDir(nextDictInfo.baseDir);
    const shouldTranslate = resolvedLocale !== 'en' && nextDictInfo.hasTargetDictionary;
    await this.savePreferences({ language: target, translationEnabled: shouldTranslate });
    await this.controller.setLocale(resolvedLocale, target, {
      dictionary: this.store.current,
      hasTargetDictionary: nextDictInfo.hasTargetDictionary,
    });
    return { translationEnabled: shouldTranslate, locale: resolvedLocale };
  }

  async stop(): Promise<void> {
    if (this.controller) { await this.controller.stop().catch(() => {}); }
    this.controller = undefined;
    this.started = false;
  }
}
