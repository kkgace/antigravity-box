// Ported from Enzoo404/gravitybox (MIT License) v1.1.2 — https://github.com/Enzoo404/gravitybox
// Windows adaptation: AntigravityBox project.
import { BundleCache } from './bundle-cache.js';
import { CdpHudBridge, HUD_BRIDGE_BINDING_NAME } from './hud.js';
import { scopedKey, describeContext, type PendingItem } from './candidates.js';
import { readFile, mkdir } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicJson, atomicText } from './files.js';
import { nativeSources, createCoverage, classifyCoverage, recountCoverage, coverageScopes, coverageTranslationLookup, resolveCoverageTranslation, type CoverageReport } from './coverage.js';
import { readPluginCatalog } from './plugin-catalog.js';
import { sanitizeNativeMenus, deepMarkdown, type DeepReport } from './deep-scan.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CDP, assertLoopback } from './cdp.js';
import {
  allowedTarget,
  discover,
  inspectBundle,
  isApplicationRunning,
  verifyPageService,
  type Endpoint,
} from './discovery.js';
import { compareLayers, type Dictionary } from './dictionary.js';
import { normalizeLocale, translate } from './i18n.js';
import {
  isEnglishSource, SUPPORTED_BUNDLES,
  fetchBundleFromOrigin,
  computeBundleSha256,
  extractUiStrings, extractedKind,
  findMissingStrings,
  createPendingList,
} from './bundle.js';

export type AssistantStatus = {
  schema: 1; mode: string; message: string; appVersion?: string; windows: number;
  dictionaryVersion: string; entries: number; dictionaryError?: string; errors: string[];
  rssMB: number; updatedAt: string; pid: number;
  translationEnabled?: boolean;
  hudEnabled?: boolean;
  unverifiedVersion?: boolean;
  newStringsCount?: number;
  pendingListPath?: string;
  bundleSha256?: string;
  menuHooked?: boolean;
  dictionaryBaseVersion?: string;
  languageMode?: string;
  locale?: string;
  configuredLanguage?: string;
  bundleCacheHit?: boolean;
  taskRevision?: number;
  bundleReads?:number;bundleBytes?:number;
};
type PageSession = { cdp: CDP; targetId: string; contextId?: number; registration?: string; updateChain: Promise<void>; url: string;languageMode?:string;detaching?:boolean };
function isSafeCandidate(key: unknown): key is string {
  return typeof key === 'string' && isEnglishSource(key) && key.length <= 400 && !/(?:https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:^|\s)(?:\/|~\/|[A-Za-z]:\\)|\b(?:sk-|AIza)[A-Za-z0-9_-]{12,})/.test(key);
}
const WORLD = 'GRAVITYBOX-localization-v1';

export class Controller {
  private endpoint?: Endpoint;
  private browser?: CDP;
  private pages = new Map<string, PageSession>();
  private reconnection?: NodeJS.Timeout;
  private targetTimer?: NodeJS.Timeout;
  private stopped = false;
  private paused = false;
  private locale = 'zh-Hans';
  private configuredLanguage = 'zh-Hans';
  private hasTargetDictionary = true;
  private get dormant() { return this.paused && !this.hudEnabled; }
  private effectiveStatusLocale(): string {
    return this.locale;
  }
  private effectiveHudLocale(): string {
    if (this.options.fixture && this.paused) return 'en';
    return this.locale;
  }
  private t(key: string, params?: Record<string, string | number | boolean | null | undefined>): string {
    return translate(this.effectiveStatusLocale(), key, params, { namespace: 'backend' });
  }
  private hudEnabled = true;
  private reconnectionDelay = 1000;
  private syncing = false;
  private syncAgain = false;
  private engine = '';
  private runtimeId='';
  private bootCache = new Map<string, string>();
  private controlChain: Promise<void> = Promise.resolve();
  private enqueueControl<T>(task: () => Promise<T>): Promise<T> {
    const run = this.controlChain.catch(() => {}).then(task);
    this.controlChain = run.then(() => {}, () => {});
    return run;
  }
  private profileWatchers: FSWatcher[] = [];
  private connecting?: Promise<void>;
  private syncWaiters: (() => void)[] = [];
  private lastInspectedSha?: string;
  private lastInspectedAppVersion?: string;
  private inspectingBundle = false;
  private unverifiedWindowRetries = 0;
  private trustedCandidates: PendingItem[] = [];
  private bundleCache = new BundleCache();
  private hudBridge: CdpHudBridge;
  private initialBundle?: string;
  private coverage?: CoverageReport;
  private coverageMissingForKey?: string;
  status: AssistantStatus;
  constructor(private options: {
    appPath: string;
    profile: string;
    fixture?: { port: number; origin: string };
    dictionary: Dictionary;
    stateDir?: string;
    geminiDir?: string;
    inspectPort?: number; // Deprecated: never opens a main-process inspector.
    shortcutEnabled?: boolean;
    hudEnabled?: boolean;
    initiallyPaused?: boolean;
    locale?: string;
    configuredLanguage?: string;
    hasTargetDictionary?: boolean;
    reloadDictionary?: () => Promise<void>;
    selectDictionary?: (version: string) => Promise<Dictionary>;
    isAppRunning?: () => Promise<boolean>;
    discoverEndpoint?: (appPath: string, profile: string) => Promise<Endpoint | undefined>;
    inspectAppBundle?: (appPath: string) => Promise<{ version: string; legacyPatch: boolean }>;
    verifyPage?: (url: string, appPath: string) => Promise<boolean>;
    onStatus: (status: AssistantStatus) => void;
  }) {
    const initialLocale = normalizeLocale(options.locale ?? '') ?? (options.initiallyPaused ? 'en' : 'zh-Hans');
    this.locale = initialLocale;
    this.configuredLanguage = options.configuredLanguage ?? initialLocale;
    this.hasTargetDictionary = options.hasTargetDictionary ?? (initialLocale !== 'en');
    this.paused = options.initiallyPaused === true || initialLocale === 'en' || !this.hasTargetDictionary;
    this.hudEnabled = options.hudEnabled !== false;
    this.hudBridge = new CdpHudBridge({
      geminiDir: options.geminiDir || process.env.GRAVITYBOX_GEMINI_DIR || process.env.GEMINI_DIR,
      stateDir: options.stateDir,
    });
    const effectiveLocale = this.effectiveStatusLocale();
    this.status = { schema: 1, mode: 'starting', message: this.t('status.starting'), windows: 0, dictionaryVersion: options.dictionary.version, entries: Object.keys(options.dictionary.entries).length, errors: [], rssMB: 0, updatedAt: '', pid: process.pid, menuHooked: false, translationEnabled: !this.paused, hudEnabled: this.hudEnabled, locale: effectiveLocale, configuredLanguage: this.configuredLanguage };
  }
  private publish(mode?: string, message?: string) {
    if (mode) this.status.mode = mode;
    if (message) this.status.message = message;
    const effectiveLocale = this.effectiveStatusLocale();
    this.status.translationEnabled = !this.paused;
    this.status.hudEnabled = this.hudEnabled;
    this.status.locale = effectiveLocale;
    this.status.configuredLanguage = this.configuredLanguage;
    this.status.windows = this.pages.size;
    this.status.bundleReads=this.bundleCache.downloads;this.status.bundleBytes=this.bundleCache.downloadedBytes;
    const modes=new Set([...this.pages.values()].map(p=>p.languageMode??(this.paused?'en':'zh')));this.status.languageMode=modes.size>1?'mixed':([...modes][0]??(this.paused?'en':'zh'));
    this.status.rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10;
    this.status.updatedAt = new Date().toISOString();
    this.options.onStatus({ ...this.status });
  }
  private activeAppPath(): string {
    return this.endpoint?.appPath ?? this.options.appPath;
  }
  private checkAppRunning(): Promise<boolean> {
    return this.options.isAppRunning
      ? this.options.isAppRunning()
      : isApplicationRunning(this.activeAppPath());
  }
  private discoverEndpoint(appPath: string, profile: string): Promise<Endpoint | undefined> {
    return this.options.discoverEndpoint
      ? this.options.discoverEndpoint(appPath, profile)
      : discover(appPath, profile);
  }
  private inspectAppBundle(appPath: string): Promise<{ version: string; legacyPatch: boolean }> {
    return this.options.inspectAppBundle
      ? this.options.inspectAppBundle(appPath)
      : inspectBundle(appPath);
  }
  private checkPageService(url: string, appPath: string): Promise<boolean> {
    return this.options.verifyPage
      ? this.options.verifyPage(url, appPath)
      : verifyPageService(url, appPath);
  }
  private closeProfileWatchers() {
    for (const w of this.profileWatchers.splice(0)) {
      try { w.close(); } catch {}
    }
  }
  private watchProfiles() {
    this.closeProfileWatchers();
    if (this.options.fixture) return;
    for (const profileDir of [this.options.profile]) {
      try {
        const watcher = watch(profileDir, (_event, name) => {
          if (String(name) === 'DevToolsActivePort' && !this.stopped && !this.dormant) {
            clearTimeout(this.reconnection);
            this.reconnectionDelay = 1000;
            this.unverifiedWindowRetries = 0;
            void this.tryConnect().catch(() => this.retry());
          }
        });
        watcher.on('error', () => { try { watcher.close(); } catch {} });
        this.profileWatchers.push(watcher);
      } catch { /* A missing profile uses bounded discovery retries. */ }
    }
  }
  async start() {
    this.engine = await readFile(new URL('./engine.js', import.meta.url), 'utf8');this.runtimeId=createHash('sha256').update(this.engine).digest('hex');
    this.watchProfiles();
    if(this.dormant) {
      if(!this.options.fixture) { this.endpoint=await this.discoverEndpoint(this.options.appPath,this.options.profile);this.status.appVersion=this.endpoint?.appVersion; }
      this.publish('paused', this.t('status.paused_keep'));return;
    }
    await this.tryConnect();
  }
  private tryConnect(): Promise<void> {
    if (this.connecting) return this.connecting;
    const attempt = this.connectOnce();
    this.connecting = attempt;
    return attempt.finally(() => { this.connecting = undefined; });
  }
  private async connectOnce() {
    if (this.stopped || this.dormant) return;
    try {
      if (this.browser) { await this.sync(); return; }
      if (this.options.fixture) {
        const port = this.options.fixture.port;
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
        const version = await response.json() as { webSocketDebuggerUrl: string };
        const url = assertLoopback(version.webSocketDebuggerUrl);
        if (Number(url.port) !== port) throw new Error(this.t('controller.err.fixture_port_mismatch'));
        this.endpoint = { port, browserURL: url.href, pid: 0, appVersion: 'fixture', legacyPatch: false };
      } else this.endpoint = await this.discoverEndpoint(this.options.appPath, this.options.profile);
      if (this.stopped || this.dormant) return;
      if (!this.endpoint) {
        if (!this.options.fixture && await this.checkAppRunning()) {
          if (this.stopped || this.dormant) return;
          const inspected = await this.inspectAppBundle(this.activeAppPath()).catch(() => undefined);
          if (this.stopped || this.dormant) return;
          if (inspected?.version) this.status.appVersion = inspected.version;
          this.publish('debug-port-missing', this.t('status.debug_port_missing'));
          this.retry(3000);
          return;
        }
        this.publish('waiting', this.t('status.waiting_app'));
        this.retry();
        return;
      }
      this.status.appVersion = this.endpoint.appVersion;
      if(this.options.selectDictionary){const dictionary=await this.options.selectDictionary(this.endpoint.appVersion);this.options.dictionary=dictionary;this.status.dictionaryVersion=dictionary.version;this.status.entries=Object.keys(dictionary.entries).length;this.bootCache.clear();}
      if (this.endpoint.legacyPatch) { this.publish('legacy-blocked', this.t('status.legacy_blocked')); this.retry(30000); return; }
      this.status.dictionaryBaseVersion = [...SUPPORTED_BUNDLES.keys()].filter(v=>compareLayers(v+'.json',this.endpoint!.appVersion+'.json')<=0).sort((a,b)=>compareLayers(a+'.json',b+'.json')).at(-1)??'base';
      if (!this.options.fixture) {
        const activeApp = this.activeAppPath();
        const targets = await (await fetch(`http://127.0.0.1:${this.endpoint.port}/json/list`, { signal: AbortSignal.timeout(2000), redirect: 'error' })).json() as {type: string; url: string}[];
        const target = targets.find(t => allowedTarget(t));
        if (!target || !await this.checkPageService(target.url, activeApp)) { this.publish('waiting-window', this.t('status.waiting_window')); this.retry(); return; }
        const bundle=await this.bundleCache.read(activeApp,this.endpoint.pid,this.endpoint.appVersion,new URL(target.url).origin);
        if(this.status.bundleSha256!==bundle.hash){this.trustedCandidates=[];}this.status.bundleSha256=bundle.hash;this.status.bundleCacheHit=bundle.cacheHit;this.initialBundle=bundle.source;
      }
      this.status.unverifiedVersion=!this.verifiedBundle();
      const browser = this.browser = new CDP(this.endpoint.browserURL);
      await browser.connect();
      if (this.stopped) { browser.close(); this.browser = undefined; return; }
      browser.on('Target.targetCreated', () => this.scheduleSync());
      browser.on('Target.targetInfoChanged', () => this.scheduleSync());
      browser.on('Target.targetDestroyed', () => this.scheduleSync());
      browser.on('disconnected', () => { void this.disconnectPages(); this.browser = undefined; if (!this.stopped) { this.reconnectionDelay = 1000; this.unverifiedWindowRetries = 0; this.publish('waiting', this.t('status.reconnecting')); this.retry(); } });
      await browser.send('Target.setDiscoverTargets', { discover: true });
      this.reconnectionDelay = 1000;
      this.unverifiedWindowRetries = 0;
      await this.sync();
    } catch (error) {
      this.browser?.close(); this.browser = undefined;
      this.publish('error', (error as Error).message); this.retry();
    }
  }
  private verifiedBundle(){const expected=SUPPORTED_BUNDLES.get(this.status.appVersion??'');return !!this.options.fixture||!!expected&&expected===this.status.bundleSha256;}
  private retry(delay?: number) {
    clearTimeout(this.reconnection);
    if (this.stopped) return;
    /* 显式传入延迟时（例如"版本未适配，30 秒后再试"）不要再去倍增基数，
       否则会把共享的 reconnectionDelay 顶到上限，污染断线重连路径。 */
    const wait = delay ?? this.reconnectionDelay;
    this.reconnection = setTimeout(() => {
        void this.tryConnect();
    }, wait);
    if (delay === undefined) this.reconnectionDelay = Math.min(30000, this.reconnectionDelay * 2);
  }
  private scheduleSync(delayMs = 100) {
    if (this.stopped) return;
    clearTimeout(this.targetTimer);
    this.targetTimer = setTimeout(() => void this.sync().catch(() => this.publish('error', this.t('status.probe_failed'))), delayMs);
  }
  private boot(url: string) {
    const page = new URL(url);
    const effectiveHudLocale = this.effectiveHudLocale();
    const languageMode = this.paused ? 'en' : (this.locale === 'zh-Hans' ? 'zh' : this.locale);
    const key = `${page.origin}${page.pathname}:${this.options.dictionary.version}:${this.verifiedBundle()}:${this.hudEnabled}:${this.paused}:${effectiveHudLocale}`;
    const cached = this.bootCache.get(key);
    if (cached) return cached;
    const source = `delete globalThis.__GRAVITYBOX_ATTACH_DEEP_SCAN__;delete globalThis.__GRAVITYBOX_ATTACH_HUD__;globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({ origin: page.origin, path: page.pathname, dictionary: this.options.dictionary, conservative:!this.verifiedBundle(),runtimeId:this.runtimeId,shortcutEnabled:this.options.shortcutEnabled!==false,hudEnabled:this.hudEnabled,translationEnabled:!this.paused,languageMode,locale:effectiveHudLocale,shellValidated:true })};\n${this.engine}`;
    if (this.bootCache.size < 4) this.bootCache.set(key, source);
    return source;
  }
  async sync() {
    if (this.syncing) { this.syncAgain = true; return; }
    if (!this.endpoint || !this.browser || this.stopped) return;
    this.syncing = true;
    try {
      const response = await fetch(`http://127.0.0.1:${this.endpoint.port}/json/list`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      const targets = await response.json() as { id: string; type: string; url: string; webSocketDebuggerUrl: string }[];
      const permitted = targets.filter(target => allowedTarget(target, this.options.fixture?.origin));
      for (const [id, session] of this.pages) {
        const target = permitted.find(target => target.id === id);
        if (!target || this.dormant) { await this.detach(session); this.pages.delete(id); }
        else if (target.url !== session.url || (session.contextId === undefined && !session.detaching)) {
          try {
            if (target.url !== session.url) {
              session.url = target.url;
              await this.refreshRegistration(session);
            }
            await this.queueBootstrap(session, false);
          } catch {
            await this.detach(session);
            this.pages.delete(id);
          }
        }
      }
      this.status.errors = [];
      if (!this.dormant) for (const target of permitted) if (!this.pages.has(target.id)) {
        if (this.dormant || this.stopped) break;
        try {
          if (!this.options.fixture && !await this.checkPageService(target.url, this.activeAppPath())) {
            this.status.errors.push(this.t('controller.err.window_unverified'));
            continue;
          }
          if (this.dormant || this.stopped) break;
          const socketURL = assertLoopback(target.webSocketDebuggerUrl);
          if (Number(socketURL.port) !== this.endpoint.port) throw new Error(this.t('controller.err.window_port_mismatch'));
          const cdp = new CDP(socketURL.href);
          const session: PageSession = { cdp, targetId: target.id, url: target.url, updateChain: Promise.resolve() };
          await cdp.connect();
          if (this.dormant || this.stopped) { cdp.close(); break; }
          this.pages.set(target.id, session);
          cdp.on('disconnected', () => {this.hudBridge.detachTarget(target.id);if(!session.detaching&&this.pages.get(target.id)===session){this.pages.delete(target.id);this.scheduleSync();}});
          cdp.on('Page.frameNavigated', (event) => {
            if (!event.frame?.parentId) {
              this.hudBridge.detachTargetPanes(target.id);
              session.contextId = undefined;
              void this.queueBootstrap(session).catch(() => this.scheduleSync(1500));
            }
          });
          cdp.on('Page.navigatedWithinDocument', () => this.scheduleSync());
          cdp.on('Runtime.executionContextsCleared', () => {
            this.hudBridge.detachTargetPanes(target.id);
            session.contextId = undefined;
            if (!session.detaching && !this.dormant && !this.stopped) this.scheduleSync(300);
          });
          await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
          await cdp.send('Runtime.addBinding',{name:'__gravityboxLanguageChanged',executionContextName:WORLD});
          await this.hudBridge.attachToTarget(target.id, cdp, () => session.contextId, WORLD);
          cdp.on('Runtime.bindingCalled',(event)=>{if(event.name==='__gravityboxLanguageChanged'&&event.executionContextId===session.contextId&&['zh','en'].includes(event.payload)){session.languageMode=event.payload;this.publish();if(this.hudEnabled){void this.hudBridge.refreshAllForLocaleChange();}}else if(event.name===HUD_BRIDGE_BINDING_NAME&&this.hudEnabled&&event.executionContextId===session.contextId){this.hudBridge.handleRawBindingPayload(target.id,event.payload);}});
          await this.refreshRegistration(session);
          await this.queueBootstrap(session, false);
        } catch(error) {
          const failed = this.pages.get(target.id); if (failed) { await this.detach(failed); this.pages.delete(target.id); }
          this.status.errors.push((error as Error).message === this.t('controller.err.unrecognized_structure') ? (error as Error).message : this.t('controller.err.window_inject_failed'));
        }
      }
      const hasUnreadyPage = [...this.pages.values()].some(session => !session.detaching && session.contextId === undefined);
      if (!this.dormant && !this.stopped && permitted.length > 0 && (this.pages.size < permitted.length || hasUnreadyPage)) {
        if (this.unverifiedWindowRetries < 20) {
          this.unverifiedWindowRetries++;
          this.scheduleSync(1500);
        }
      } else {
        this.unverifiedWindowRetries = 0;
      }
      const isVerified = this.verifiedBundle();
      const defaultMode = this.paused
        ? 'paused'
        : this.pages.size
          ? (isVerified ? 'connected' : 'adaptive')
          : 'waiting-window';
      const defaultMsg = this.paused
        ? this.t('status.paused')
        : this.pages.size
          ? (isVerified
              ? this.t('status.connected_watch')
              : (this.status.newStringsCount
                  ? this.t('status.connected_adaptive_new', { version: this.endpoint?.appVersion ?? '', count: this.status.newStringsCount })
                  : this.t('status.connected_adaptive', { version: this.endpoint?.appVersion ?? '' })))
          : this.t('status.waiting_supported_window');
      this.publish(defaultMode, defaultMsg);

      if (!this.options.fixture && this.endpoint && permitted.length > 0 && !this.inspectingBundle && (this.lastInspectedAppVersion !== this.endpoint.appVersion || this.lastInspectedSha!==this.status.bundleSha256)) {
        const pageTarget = permitted[0];
        if (pageTarget) {
          try {
            const origin = new URL(pageTarget.url).origin;
            void this.inspectBundleInBackground(origin, this.endpoint.appVersion,this.initialBundle);this.initialBundle=undefined;
          } catch {}
        }
      }
      } finally {
      this.initialBundle=undefined;
      this.syncing = false;
      for (const resolve of this.syncWaiters.splice(0)) resolve();
      if (this.syncAgain) { this.syncAgain = false; this.scheduleSync(); }
    }
  }
  private queueBootstrap(session: PageSession, reportUnhandledError = true): Promise<void> {
    if(session.detaching)return Promise.resolve();
    session.updateChain = session.updateChain.catch(() => {}).then(async () => {
      if (this.dormant || this.stopped || session.detaching || this.pages.get(session.targetId)!==session) return;
      const tree = await session.cdp.send('Page.getFrameTree');
      const frame = tree.frameTree.frame;
      if (!allowedTarget({ type: 'page', url: frame.url }, this.options.fixture?.origin)) return;
      if(!this.options.fixture&&this.endpoint){
        const activeApp = this.activeAppPath();
        if(!await this.checkPageService(frame.url,activeApp))throw new Error(this.t('controller.err.page_unverified'));
        const bundle=await this.bundleCache.read(activeApp,this.endpoint.pid,this.endpoint.appVersion,new URL(frame.url).origin);
        this.status.bundleSha256=bundle.hash;this.status.bundleCacheHit=bundle.cacheHit;this.status.unverifiedVersion=!this.verifiedBundle();
        if(bundle.source)this.initialBundle=bundle.source;
      }

      session.url = frame.url;
      let previous: any;
      if (session.contextId !== undefined) {
        try {
          previous = await session.cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__?.state()', session.contextId);
        } catch {
          session.contextId = undefined;
        }
      }
      if (session.contextId === undefined || !previous?.active) {
        const context = await session.cdp.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: WORLD });
        session.contextId = context.executionContextId;
      }
      if(!this.verifiedBundle()){
        if(/^\/(?:onboarding|oauth|auth|login|sign-in)(?:\/|$)/i.test(new URL(frame.url).pathname))throw new Error(this.t('controller.err.onboarding_skipped'));
        const contract=await session.cdp.evaluate(`(async()=>{for(let i=0;i<30;i++){if(!!document.body&&((!!document.querySelector('[aria-label*="Sidebar" i],[aria-label*="侧边栏"],[data-testid*="sidebar" i],[data-testid="agent-input-box"]')&&!!document.querySelector('[data-testid="model-selector-trigger"],a[href="/history"],a[href="/customizations"],[data-testid="agent-input-box"],textarea,input'))||(/^\\/(?:settings(?:\\/[^?#]*)?|settings-standalone)$/.test(location.pathname)&&!!document.querySelector('[role="dialog"][aria-label="Settings"],[role="dialog"][aria-label="设置"],[data-testid*="settings"]')&&!!document.querySelector('[role="tablist"],nav,[role="navigation"]'))||(location.pathname==='/terminal-standalone'&&!!document.querySelector('.xterm,.monaco-editor,[data-testid*="terminal"]'))))return true;await new Promise(r=>setTimeout(r,100));}return false;})()`,session.contextId);
        if(!contract)throw new Error(this.t('controller.err.unrecognized_structure'));
      }
      if(this.dormant||this.stopped||session.detaching)return;
      if (!previous?.active) previous = await session.cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__?.state()', session.contextId);
      if(this.dormant||this.stopped||session.detaching)return;
      const preservedManualEn = !this.paused && session.languageMode === 'en';
      if (previous?.active&&previous.runtimeId===this.runtimeId) {
        if (previous.version === this.options.dictionary.version) await session.cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.refresh()', session.contextId);
        else await session.cdp.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__.update(${JSON.stringify(this.options.dictionary)})`, session.contextId);
        const desiredLanguageMode = this.paused ? 'en' : preservedManualEn ? 'en' : (this.locale === 'zh-Hans' ? 'zh' : 'en');
        if (!this.paused && !this.options.fixture && previous.languageMode && previous.languageMode !== desiredLanguageMode) {
          await session.cdp.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__?.toggleLanguage?.(${JSON.stringify(desiredLanguageMode)})`, session.contextId);
        }
      }
      else{if(previous?.active)await session.cdp.evaluate(this.hudEnabled?'globalThis.__GRAVITYBOX_ENGINE_V1__?.dispose?.({keepHud:true})':'(globalThis.__GRAVITYBOX_ENGINE_V1__?.dispose?.(),globalThis.__GRAVITYBOX_HUD_V1__?.dispose?.())',session.contextId);await session.cdp.evaluate(this.boot(session.url),session.contextId);if((this.options.fixture||preservedManualEn)&&!this.paused&&(previous?.languageMode==='en'||preservedManualEn))await session.cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__?.toggleLanguage?.("en")',session.contextId);}
      let state: any;
      for (let i = 0; i < 10; i++) {
        state = await session.cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__?.state()', session.contextId);
        if (state?.version === this.options.dictionary.version) break;
        await new Promise(r => setTimeout(r, 100));
      }
      if (state?.version !== this.options.dictionary.version) throw new Error(this.t('controller.err.dict_version_unconfirmed'));
      session.languageMode=state.languageMode??'zh';
      const effectiveHudLocale = !this.paused && session.languageMode === 'en' ? 'en' : this.effectiveHudLocale();
      if (this.hudEnabled) {
        await session.cdp.evaluate(`(globalThis.__GRAVITYBOX_ATTACH_HUD__?.(), globalThis.__GRAVITYBOX_HUD_V1__?.setLanguage?.(${JSON.stringify(effectiveHudLocale)}), globalThis.__GRAVITYBOX_HUD_V1__?.setEnabled?.(true), globalThis.__GRAVITYBOX_HUD_V1__?.syncAllSessions?.())`, session.contextId).catch(() => {});
      } else {
        await session.cdp.evaluate('globalThis.__GRAVITYBOX_HUD_V1__?.setEnabled?.(false)', session.contextId).catch(() => {});
      }
    });
    if (reportUnhandledError) {
      session.updateChain.catch(() => {
        if (!this.status.errors.includes(this.t('controller.err.window_connect_failed'))) this.status.errors.push(this.t('controller.err.window_connect_failed'));
        this.publish();
      });
    }
    return session.updateChain;
  }
  private refreshRegistration(session: PageSession):Promise<void> {
    if(session.detaching)return Promise.resolve();
    session.updateChain=session.updateChain.catch(()=>{}).then(async()=>{
      if(session.detaching||this.dormant||this.stopped)return;
      if(session.registration){await session.cdp.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:session.registration});session.registration=undefined;}
      if(session.detaching||this.dormant||this.stopped)return;
      const registered=await session.cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:this.boot(session.url),worldName:WORLD});
      if(session.detaching||this.dormant||this.stopped){await session.cdp.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:registered.identifier});return;}
      session.registration=registered.identifier;
    });return session.updateChain;
  }
  /** 后台异步对比界面包指纹，提取界面串并检测未译新词，不阻塞前台窗口注入与翻译。 */
  private async inspectBundleInBackground(origin: string, appVersion: string,initialSource?:string): Promise<void> {
    if (this.inspectingBundle || this.stopped) return;
    this.inspectingBundle = true;
    try {
      const source = initialSource??await fetchBundleFromOrigin(origin, 8000);
      const sha = computeBundleSha256(source);
      this.status.bundleSha256 = sha;
      this.lastInspectedAppVersion = appVersion;
      if (this.lastInspectedSha === sha) return;
      this.lastInspectedSha = sha;

      const extracted = extractUiStrings(source, { includeJsxRuntime: true });
      const missing = findMissingStrings(extracted, this.options.dictionary);
      this.trustedCandidates = missing.filter(isSafeCandidate).map(key=>({key,kind:extractedKind(extracted.find(e=>e.text===key)?.kinds),source:'static'}));
      this.status.newStringsCount = this.trustedCandidates.length;

      if (this.options.stateDir) {
        const reportsDir = join(this.options.stateDir, 'reports');
        await mkdir(reportsDir, { recursive: true });
        if (!this.verifiedBundle()) {
          const byKind: Record<string, number> = {};
          for (const entry of extracted) for (const kind of entry.kinds) byKind[kind] = (byKind[kind] ?? 0) + 1;
          await atomicJson(join(reportsDir, `ui-strings-${appVersion}.json`), {
            schema: 1,
            appVersion,
            source: 'runtime-loopback',
            bundleSha256: sha,
            bundleBytes: Buffer.byteLength(source),
            extractedAt: new Date().toISOString(),
            counts: { total: extracted.length, ...byKind },
            strings: extracted,
          }).catch(() => {});
        }
        if (this.trustedCandidates.length > 0) {
          const pendingPath = join(reportsDir, `pending-${appVersion}.json`);
          const pendingPayload = createPendingList(appVersion, sha, this.trustedCandidates.map(e=>e.key));
          await atomicJson(pendingPath, pendingPayload);
          this.status.pendingListPath = pendingPath;
        }
      }

      if (this.stopped || this.paused) return;
      const isVerified = this.verifiedBundle();
      const candidateCount = this.trustedCandidates.length;
      if (!isVerified) {
        const msg = candidateCount > 0
          ? this.t('status.adaptive_candidates', { version: appVersion, count: candidateCount })
          : this.t('status.adaptive_matched', { version: appVersion });
        this.publish('adaptive', msg);
      } else if (candidateCount > 0) {
        this.publish('connected', this.t('status.connected_candidates', { count: candidateCount }));
      }
    } catch {
      // 后台探测异常不影响前台窗口注入与翻译
    } finally {
      this.inspectingBundle = false;
    }
  }
  update(dictionary: Dictionary): Promise<void> {
    return this.enqueueControl(() => this.applyDictionary(dictionary));
  }
  private async applyDictionary(dictionary: Dictionary) {
    this.options.dictionary = dictionary;
    this.bootCache.clear();
    this.status.dictionaryVersion = dictionary.version; this.status.entries = Object.keys(dictionary.entries).length;
    this.status.errors = [];
    const results = await Promise.allSettled([...this.pages.values()].map(async session => {
      await this.refreshRegistration(session);
      await this.queueBootstrap(session);
    }));
    if (results.some(result => result.status === 'rejected')) this.status.errors.push(this.t('controller.err.partial_dict_update'));
    this.publish();
  }
  dictionaryError(message?: string) { this.status.dictionaryError = message; this.publish(); }
  private async detach(session: PageSession) {
    session.detaching=true;
    this.hudBridge.detachTarget(session.targetId);
    let restorationFailed = false;
    try {
      await session.updateChain.catch(() => {});
      if (session.registration) await session.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.registration });
      let ctxId = session.contextId;
      if (ctxId === undefined) {
        const tree = await session.cdp.send('Page.getFrameTree');
        const world = await session.cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: WORLD });
        ctxId = world.executionContextId;
      }
      await session.cdp.evaluate('(globalThis.__GRAVITYBOX_PENDING_BOOT__?.cancel(),globalThis.__GRAVITYBOX_ENGINE_V1__?.dispose(),globalThis.__GRAVITYBOX_HUD_V1__?.dispose())', ctxId);
    } catch { restorationFailed = true; }
    session.cdp.close();
    if (restorationFailed) this.status.errors.push(this.t('controller.err.window_lost_restore'));
  }
  private async disconnectPages() { for (const session of this.pages.values()) await this.detach(session); this.pages.clear(); }
  private async quiescePages() {
    await this.connecting?.catch(() => {});
    if (this.syncing) await new Promise<void>(resolve => this.syncWaiters.push(resolve));
    await this.disconnectPages();
  }
  private async quiesce() {
    await this.controlChain.catch(() => {});
    await this.quiescePages();
  }
  private async transitionActiveSessionsToHudOnly(): Promise<void> {
    await this.connecting?.catch(() => {});
    if (this.syncing) await new Promise<void>(resolve => this.syncWaiters.push(resolve));
    if (!this.hudEnabled) {
      await this.disconnectPages();
      return;
    }
    const hudLocale = this.effectiveHudLocale();
    for (const [id, session] of [...this.pages.entries()]) {
      if (session.detaching) continue;
      try {
        await session.updateChain.catch(() => {});
        const tree = await session.cdp.send('Page.getFrameTree');
        const frame = tree.frameTree.frame;
        if (!allowedTarget({ type: 'page', url: frame.url }, this.options.fixture?.origin)) {
          await this.detach(session);
          this.pages.delete(id);
          continue;
        }
        session.url = frame.url;
        await this.refreshRegistration(session);
        if (session.contextId === undefined) {
          const world = await session.cdp.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: WORLD });
          session.contextId = world.executionContextId;
        }
        await session.cdp.evaluate(
          '(globalThis.__GRAVITYBOX_PENDING_BOOT__?.cancel?.(),globalThis.__GRAVITYBOX_ENGINE_V1__?.dispose?.({keepHud:true}))',
          session.contextId
        );
        await session.cdp.evaluate(this.boot(session.url), session.contextId);
        await session.cdp.evaluate(
          `(globalThis.__GRAVITYBOX_ATTACH_HUD__?.(), globalThis.__GRAVITYBOX_HUD_V1__?.setLanguage?.(${JSON.stringify(hudLocale)}), globalThis.__GRAVITYBOX_HUD_V1__?.setEnabled?.(true))`,
          session.contextId
        );
        session.languageMode = 'en';
      } catch {
        await this.detach(session);
        this.pages.delete(id);
      }
    }
  }
  pause(): Promise<void> {
    return this.enqueueControl(async () => {
      const prevHudLocale = this.effectiveHudLocale();
      this.paused = true;
      this.status.errors = [];
      this.bootCache.clear();
      await this.transitionActiveSessionsToHudOnly();
      if (this.hudEnabled) {
        await this.resumeHudOnly();
        if (this.effectiveHudLocale() !== prevHudLocale) {
          await this.hudBridge.refreshAllForLocaleChange();
        }
        if (!this.browser && this.status.mode === 'debug-port-missing') {
          this.publish('debug-port-missing', this.t('status.debug_port_missing'));
          return;
        }
      } else {
        clearTimeout(this.reconnection);
      }
      this.publish('paused', this.status.errors.length ? this.t('status.pausedWithErrors') : this.t('status.paused'));
    });
  }
  private async resumeHudOnly() {
    if (this.browser) await this.sync(); else await this.tryConnect();
  }
  private async resumeInternal() {
    const prevHudLocale = this.effectiveHudLocale();
    // Recreate the isolated runtime so translation starts from the chosen mode.
    if (this.locale === 'en') {
      this.locale = 'zh-Hans';
      this.configuredLanguage = 'zh-Hans';
      this.hasTargetDictionary = true;
    }
    const wasPaused = this.paused;
    if (wasPaused && this.pages.size && !this.hudEnabled) await this.disconnectPages();
    this.paused = false;
    this.reconnectionDelay = 1000;
    this.unverifiedWindowRetries = 0;
    this.bootCache.clear();
    if (wasPaused && this.hudEnabled && this.pages.size) {
      for (const [id, session] of [...this.pages.entries()]) {
        if (session.detaching) continue;
        session.languageMode = undefined;
        try {
          if (session.contextId !== undefined) {
            await session.cdp.evaluate(
              '(globalThis.__GRAVITYBOX_PENDING_BOOT__?.cancel?.(),globalThis.__GRAVITYBOX_ENGINE_V1__?.dispose?.({keepHud:true}))',
              session.contextId
            );
          }
          await this.refreshRegistration(session);
          await this.queueBootstrap(session, false);
        } catch {
          await this.detach(session);
          this.pages.delete(id);
        }
      }
    }
    try {
      if (this.browser) await this.sync();
      else { clearTimeout(this.reconnection); await this.tryConnect(); }
    } catch {
      this.browser?.close();
      this.browser = undefined;
      clearTimeout(this.reconnection);
      await this.tryConnect();
    }
    if (this.hudEnabled && this.effectiveHudLocale() !== prevHudLocale) {
      await this.hudBridge.refreshAllForLocaleChange();
    }
  }
  resume(): Promise<void> {
    return this.enqueueControl(() => this.resumeInternal());
  }
  setLocale(
    nextLocale: string,
    configuredLanguage?: string,
    options?: { dictionary?: Dictionary; hasTargetDictionary?: boolean }
  ): Promise<void> {
    return this.enqueueControl(async () => {
      const resolved = normalizeLocale(nextLocale) ?? 'en';
      const previousLocale = this.locale;
      const previousPaused = this.paused;
      this.locale = resolved;
      this.configuredLanguage = configuredLanguage ?? resolved;
      this.hasTargetDictionary = options?.hasTargetDictionary ?? (resolved !== 'en');
      this.status.errors = [];
      if (options?.dictionary) {
        this.options.dictionary = options.dictionary;
        this.status.dictionaryVersion = options.dictionary.version;
        this.status.entries = Object.keys(options.dictionary.entries).length;
      }
      if (previousLocale !== resolved) {
        for (const s of this.pages.values()) s.languageMode = undefined;
      }
      this.bootCache.clear();
      const shouldTranslateDom = resolved !== 'en' && this.hasTargetDictionary;
      if (!shouldTranslateDom) {
        this.paused = true;
        if (!previousPaused || previousLocale !== resolved) {
          await this.transitionActiveSessionsToHudOnly();
          if (this.hudEnabled) {
            await this.resumeHudOnly();
            await this.hudBridge.refreshAllForLocaleChange();
          } else {
            clearTimeout(this.reconnection);
            this.hudBridge.clearActivePanes();
            this.browser?.close();
            this.browser = undefined;
          }
        }
        if (this.hudEnabled && !this.browser && this.status.mode === 'debug-port-missing') {
          this.publish('debug-port-missing', this.t('status.debug_port_missing'));
          return;
        }
        const message = this.status.errors.length
          ? this.t('status.pausedWithErrors')
          : this.t('status.paused');
        this.publish('paused', message);
        return;
      }
      if (previousPaused) {
        await this.resumeInternal();
        if (this.hudEnabled) {
          await this.hudBridge.refreshAllForLocaleChange();
        }
        return;
      }
      if (options?.dictionary) {
        await this.applyDictionary(options.dictionary);
      }
      const effectiveHudLocale = this.effectiveHudLocale();
      await Promise.allSettled([...this.pages.values()].map(async session => {
        await this.refreshRegistration(session);
        if (session.contextId !== undefined && !session.detaching) {
          await session.cdp.evaluate(
            `globalThis.__GRAVITYBOX_HUD_V1__?.setLanguage?.(${JSON.stringify(effectiveHudLocale)})`,
            session.contextId
          );
        }
      }));
      if (this.hudEnabled) {
        await this.hudBridge.refreshAllForLocaleChange();
      }
      if (!this.browser && this.status.mode === 'debug-port-missing') {
        this.publish('debug-port-missing', this.t('status.debug_port_missing'));
        return;
      }
      this.publish();
    });
  }
  /** @internal Fixture-only shortcut toggle; no-op in production. */
  configureShortcut(enabled: boolean): Promise<void> {
    return this.enqueueControl(async () => {
      if (!this.options.fixture) return;
      this.options.shortcutEnabled = enabled;
      this.bootCache.clear();
      await Promise.allSettled([...this.pages.values()].map(async session => {
        await this.refreshRegistration(session);
        if (session.contextId !== undefined && !session.detaching) {
          await session.cdp.evaluate(
            `globalThis.__GRAVITYBOX_ENGINE_V1__?.setShortcutEnabled(${enabled})`,
            session.contextId
          );
        }
      }));
    });
  }
  configureHud(enabled: boolean): Promise<void> {
    return this.enqueueControl(async () => {
      this.hudEnabled = enabled;
      this.options.hudEnabled = enabled;
      this.bootCache.clear();
      if (this.paused) {
        await this.disconnectPages();
        if (enabled) {
          await this.resumeHudOnly();
        } else {
          clearTimeout(this.reconnection);
          this.hudBridge.clearActivePanes();
          this.browser?.close();
          this.browser = undefined;
          this.publish('paused', this.t('status.paused_keep'));
          return;
        }
        this.publish(); return;
      }
      if (!enabled) {
        this.hudBridge.clearActivePanes();
      }
      const effectiveHudLocale = this.effectiveHudLocale();
      await Promise.allSettled([...this.pages.values()].map(async session => {
        await this.refreshRegistration(session);
        if (session.contextId !== undefined && !session.detaching) {
          if (enabled) {
            await session.cdp.evaluate(
              `((globalThis.__GRAVITYBOX_BOOT__&&(globalThis.__GRAVITYBOX_BOOT__.hudEnabled=true)),globalThis.__GRAVITYBOX_ATTACH_HUD__?.(),globalThis.__GRAVITYBOX_HUD_V1__?.setLanguage?.(${JSON.stringify(effectiveHudLocale)}),globalThis.__GRAVITYBOX_HUD_V1__?.setEnabled?.(true),globalThis.__GRAVITYBOX_HUD_V1__?.syncAllSessions?.())`,
              session.contextId
            );
          } else {
            await session.cdp.evaluate('((globalThis.__GRAVITYBOX_BOOT__&&(globalThis.__GRAVITYBOX_BOOT__.hudEnabled=false)),globalThis.__GRAVITYBOX_HUD_V1__?.setEnabled?.(false))', session.contextId);
          }
        }
      }));
      this.publish();
    });
  }
  toggleLanguage(mode?: 'zh' | 'en'): Promise<void> {
    return this.enqueueControl(async () => {
      if (this.paused || !this.pages.size) return;
      await Promise.allSettled([...this.pages.values()].map(async session => {
        if (session.contextId !== undefined && !session.detaching) {
          await session.cdp.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__?.toggleLanguage(${mode ? JSON.stringify(mode) : ''})`, session.contextId);
        }
      }));
    });
  }
  snapshot(): AssistantStatus {
    this.status.rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10;
    this.status.updatedAt = new Date().toISOString();
    return { ...this.status, errors: [...this.status.errors] };
  }
  async coverageReport(): Promise<CoverageReport | undefined> {
    if (this.coverage && (this.coverage.appVersion !== this.status.appVersion || this.coverage.bundleSha256 !== this.status.bundleSha256)) {
      this.coverage = undefined;
    }
    const versionKey = `${this.status.appVersion ?? ''}:${this.status.bundleSha256 ?? ''}`;
    if (!this.coverage && this.options.stateDir && this.coverageMissingForKey !== versionKey) {
      try {
        const saved = JSON.parse(await readFile(join(this.options.stateDir,'reports/coverage.json'),'utf8'));
        if(saved.schema===1 && saved.appVersion===this.status.appVersion && saved.bundleSha256===this.status.bundleSha256) {
          this.coverage=saved;
          this.coverageMissingForKey=undefined;
        } else {
          this.coverageMissingForKey=versionKey;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') this.coverageMissingForKey = versionKey;
      }
    }
    if (this.coverage && (!this.coverage.statusCounts || !this.coverage.observedCounts)) recountCoverage(this.coverage);
    if(this.coverage && this.coverage.dictionaryVersion!==this.options.dictionary.version){
      const lookup=coverageTranslationLookup(this.options.dictionary);
      for(const entry of this.coverage.entries){
        if(entry.status==='native')continue;
        /* 先按已知场景精确命中 @ui:<route>|<kind>|<原文>，再退回普通键/任意场景译文。 */
        const resolved=resolveCoverageTranslation(entry.key,lookup,coverageScopes(entry));
        const next=resolved.translation;
        if(next!==entry.translation){delete entry.observed;delete entry.observations;}
        entry.translation=next;entry.scoped=resolved.scoped;
        entry.status=resolved.ambiguous?'review':classifyCoverage(entry.key,next,entry.status==='dynamic');
        if(entry.confidence==='literal'&&entry.status==='missing')entry.status='review';
      }
      this.coverage.dictionaryVersion=this.options.dictionary.version;recountCoverage(this.coverage);
    }
    return this.coverage;
  }
  coverageEditable(entry:CoverageReport['entries'][number]){return entry.confidence==='ui'&&!['native','review','dynamic'].includes(entry.status)&&coverageScopes(entry).length<=1;}
  async prepareCoverageEdit(key:unknown){
    if(typeof key!=='string')throw new Error(this.t('controller.coverage.select_entry'));
    const report=await this.coverageReport(), entry=report?.entries.find(e=>e.key===key);
    if(!entry||!this.coverageEditable(entry))throw new Error(this.t('controller.coverage.not_editable'));
    const scope=coverageScopes(entry)[0], normalized=key.replace(/\s+/g,' ').trim(), target=scope?scopedKey(normalized,scope.kind,scope.route):normalized;
    return{key:target,displayKey:key,context:scope?describeContext(scope):this.t('controller.coverage.general_context'),value:this.options.dictionary.entries[target]??entry.translation??'',version:this.options.dictionary.version};
  }
  async hasRunningAgentTask(): Promise<{ busy: boolean; reason?: string }> {
    for (const page of this.pages.values()) {
      if (page.contextId === undefined) continue;
      try {
        const res = await Promise.race([
          page.cdp.evaluate(
            `(() => {
              const engineState = globalThis.__GRAVITYBOX_ENGINE_V1__?.draftState?.();
              if (engineState?.generating) return { busy: true, reason: ${JSON.stringify(this.t('controller.task.streaming_busy'))} };
              const rendered = e => !!e?.getClientRects?.().length && getComputedStyle(e).visibility !== 'hidden';
              const stopBtn = [...document.querySelectorAll('button,[role="button"],[data-testid*="stop"],[data-testid*="cancel"]')].some(e => {
                if (!rendered(e)) return false;
                const label = (e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('data-tooltip-id') || e.textContent || '').trim();
                if (/^(Stop generating|Stop|Cancel generation|Cancel|Abort|Interrupt|停止生成|停止|取消生成|终止生成|中断)$/i.test(label)) return true;
                if (/(?:stop|cancel)\s*(?:generation|generating|streaming|agent|response|task)/i.test(label)) return true;
                if (e.querySelector?.('.codicon-debug-stop, .codicon-stop-circle')) return true;
                return false;
              });
              if (stopBtn) return { busy: true, reason: ${JSON.stringify(this.t('controller.task.agent_busy'))} };
              const streaming = [...document.querySelectorAll('[data-state="streaming"],[data-streaming="true"],.codicon-loading')].some(rendered);
              if (streaming) return { busy: true, reason: ${JSON.stringify(this.t('controller.task.agent_busy'))} };
              return { busy: false };
            })()`,
            page.contextId
          ),
          new Promise<{ busy: boolean }>(resolve => setTimeout(() => resolve({ busy: false }), 600)),
        ]);
        if (res?.busy) return res;
      } catch {}
    }
    return { busy: false };
  }
  async maintenancePreflight(){
    if(!this.endpoint||!this.pages.size)return{ok:true,pid:0};
    const endpoint=await discover(this.options.appPath,this.options.profile);if(!endpoint||endpoint.pid!==this.endpoint.pid)return{ok:true,pid:endpoint?.pid??0};
    const agentTask=await this.hasRunningAgentTask();
    if(agentTask.busy)throw new Error(agentTask.reason?this.t('controller.preflight.reason_wait', { reason: agentTask.reason }):this.t('controller.preflight.task_wait'));
    for(const page of this.pages.values()){
      if(page.contextId===undefined)continue;
      const state=await page.cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__?.maintenanceState?.()',page.contextId);
      if(state?.busy)throw new Error(this.t('controller.preflight.save_drafts'));
    }
    return{ok:true,pid:endpoint.pid};
  }
  async prepareDeepScan() {
    if(this.options.fixture)throw new Error(this.t('controller.scan.fixture_unsupported'));
    const endpoint=await discover(this.options.appPath,this.options.profile);
    if(!endpoint||endpoint.pid!==this.endpoint?.pid||endpoint.appVersion!==this.status.appVersion)throw new Error(this.t('controller.scan.connect_app_first'));
    const sources=await nativeSources(endpoint.appPath ?? this.activeAppPath());
    const report=createCoverage(sources,this.options.dictionary,endpoint.appVersion,this.status.bundleSha256??'');
    const defaults=['Antigravity','File','Edit','View','Window','Help','Services','Hide Antigravity','Hide Others','Show All','Quit Antigravity','About Antigravity','Undo','Redo','Cut','Copy','Paste','Paste and Match Style','Delete','Select All','Minimize','Zoom','Bring All to Front','Open Recent','Clear Menu'];
    const names=[...defaults,...report.entries.map(e=>e.key)];
    return {pid:endpoint.pid,nativeKeys:[...new Set([...names,...names.map(k=>this.options.dictionary.entries[k]).filter((v):v is string=>typeof v==='string')])].filter(k=>k.length<=200).slice(0,1200)};
  }
  async metadataScan(signal:AbortSignal,nativeInput?:unknown,onCommit?:()=>void){
    const prepared=await this.prepareDeepScan();signal.throwIfAborted();
    const report=await this.coverageReport()??createCoverage([],this.options.dictionary,this.status.appVersion??'unknown',this.status.bundleSha256??'',[]);
    const deep:DeepReport={schema:1,scope:'metadata',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),state:'partial',steps:[],plugins:await readPluginCatalog(join(homedir(),'.gemini/config/plugins'),signal),nativeMenus:sanitizeNativeMenus(nativeInput,new Set(prepared.nativeKeys)),notes:[this.t('controller.scan.note_metadata_only'),this.t('controller.scan.note_local_only')]};
    const reportFilename = this.t('deep_scan.report_filename');
    deep.state=deep.nativeMenus.state==='read'&&!deep.plugins.limited?'complete':'partial';report.deep=deep;signal.throwIfAborted();onCommit?.();const directory=join(this.options.stateDir!,'reports');await atomicJson(join(directory,'coverage.json'),report,signal);await atomicJson(join(directory,'deep-scan.json'),deep,signal);await atomicText(join(directory,reportFilename),deepMarkdown(deep),signal);this.coverage=report;this.publish();return{ok:deep.state==='complete',partial:true,message:this.t('controller.scan.summary', { count: deep.plugins.entries.length, menuMessage: deep.nativeMenus.message })};
  }
  async stop() {
    this.stopped = true; this.closeProfileWatchers(); clearTimeout(this.reconnection); clearTimeout(this.targetTimer);
    this.hudBridge.dispose();
    await this.quiesce();
    this.browser?.close();
    this.publish('stopped', this.status.errors.length ? this.t('status.stopped_with_errors') : this.t('status.stopped'));
  }
}

