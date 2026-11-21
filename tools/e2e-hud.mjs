// AntigravityBox M2 E2E — HUD / 汉化引擎(非侵入式)。
// 在真实环境下启动 HudService:验证词典分层加载、engine 注入包就绪、CDP 发现与状态机。
// 绝不重启/修改正在运行的 Antigravity(安全重启协议仅在渲染层用户确认后触发)。
import { stateDir, defaultGeminiDir } from '../dist/windows/paths.js';
import { applicationTarget } from '../dist/core/application-target.js';
import { HudService } from '../dist/electron/hud.js';

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const target = applicationTarget();

// 1. engine 注入包就绪且包含 HUD 运行时契约
{
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const enginePath = join(here, '..', 'dist', 'core', 'engine.js');
  try {
    const engine = await readFile(enginePath, 'utf8');
    const hasEngineKey = engine.includes('__GRAVITYBOX_ENGINE_V1__');
    const hasBoot = engine.includes('__GRAVITYBOX_BOOT__');
    const hasHud = engine.includes('bootstrapGravityBoxHud') && engine.includes('HUD_I18N');
    record('engine.bundle', hasEngineKey && hasBoot && hasHud, `bytes=${engine.length} engineKey=${hasEngineKey} boot=${hasBoot} hud=${hasHud}`);
  } catch (error) {
    record('engine.bundle', false, error.message);
  }
}

// 2. 词典分层可加载(真实 dict 目录 + stateDir 用户层)
{
  const { DictionaryStore, resolveDictionaryForLocale } = await import('../dist/core/dictionary.js');
  try {
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const baseDir = join(here, '..', 'dist', 'dict');
    const info = await resolveDictionaryForLocale(baseDir, 'zh-Hans');
    const userDictDir = join(stateDir(), 'dictionary');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(userDictDir, { recursive: true });
    const store = new DictionaryStore(info.baseDir, userDictDir);
    await store.start();
    const entries = Object.keys(store.current?.entries ?? {}).length;
    record('dict.layers', entries > 0 && info.hasTargetDictionary, `version=${store.current?.version} entries=${entries}`);
    store.close?.();
  } catch (error) {
    record('dict.layers', false, error.message);
  }
}

// 3. HUD 服务真实启动 → CDP 状态机(预期 debug-port-missing,因本机 Antigravity 未带调试端口)
{
  let statusUpdate = null;
  const hud = new HudService(
    target.appPath,
    target.profile,
    defaultGeminiDir(),
    stateDir(),
    status => { statusUpdate = status; },
  );
  try {
    await hud.start();
    await new Promise(r => setTimeout(r, 6000));
    const status = await hud.status();
    const mode = String(status.mode ?? '');
    // 合法模式取决于真实环境(UI 是否运行/是否带调试端口/是否存在第三方汉化补丁):
    // 本机带 legacyPatch 且 UI 带端口时会进入 legacy-blocked —— 零修改闸门按设计拦截。
    const meaningful = ['connected', 'legacy-blocked', 'debug-port-missing', 'waiting', 'waiting-window', 'paused', 'starting'];
    record('hud.state_machine', meaningful.includes(mode), `mode=${mode} appVersion=${status.appVersion ?? '?'} windows=${status.windows ?? 0} message=${String(status.message ?? '').slice(0, 40)}`);
    // 4. 语言切换链(运行时偏好持久化 + 控制器 locale)
    const langResult = await hud.setLanguage('zh-Hans');
    record('hud.language_set', langResult.translationEnabled === true, `locale=${langResult.locale} translationEnabled=${langResult.translationEnabled}`);
    // 5. HUD 开关
    await hud.setHudEnabled(false);
    const paused = await hud.status();
    record('hud.toggle_off', paused.hudEnabled === false, `hudEnabled=${paused.hudEnabled}`);
    await hud.setHudEnabled(true);
  } catch (error) {
    record('hud.state_machine', false, error.message);
  } finally {
    await hud.stop();
  }
  void statusUpdate;
}

console.log('\n====', results.filter(r => r.ok).length, '/', results.length, 'passed ====');
process.exit(results.every(r => r.ok) ? 0 : 1);
