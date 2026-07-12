export async function register() {
  // Next.js 会对 instrumentation 同时打 Node 与 Edge 两份 bundle。
  // 顶层静态 import 会把 fs/path/db 等 Node API 拖进 Edge，触发编译告警。
  // 因此 migrate / seed / debugLog / undici 全部放进 nodejs 分支内动态 import。
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 仅在 Node runtime 加载依赖 Node API 的模块
    const { migrate } = await import('./lib/db/client');
    const { ensureSeed } = await import('./lib/db/seed');
    const { debugLog } = await import('./lib/debug-log');

    // 代理支持:Node 原生 fetch(undici)不读 HTTP_PROXY/HTTPS_PROXY 环境变量,
    // 需显式 setGlobalDispatcher(ProxyAgent);否则 webtool 访问需代理的云端 eve(Vercel/hf.space)
    // 会超时,probe 静默 return false,表现为"连不上且无报错"(AGENTS.md §13:日志可定位)
    // 动态 import + try/catch:未装 undici 时不崩,仅打错误日志提示 `pnpm add undici`
    // WS-020：副作用仅在 nodejs runtime + 有代理 URL 时执行
    const proxyUrl =
      process.env.HTTPS_PROXY || process.env.HTTP_PROXY ||
      process.env.https_proxy || process.env.http_proxy;
    if (proxyUrl) {
      try {
        const { ProxyAgent, setGlobalDispatcher } = await import('undici');
        setGlobalDispatcher(new ProxyAgent(proxyUrl));
        debugLog('db', `proxy enabled: ${proxyUrl}`);
        console.log(`[instrumentation] 全局代理已启用: ${proxyUrl}`);
      } catch (err) {
        debugLog('db', `proxy enable failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error(`[instrumentation] 代理启用失败(需 pnpm add undici):`, err);
      }
    }
    // WS-021：migrate/seed 失败必须落本地日志
    try {
      await migrate();
      debugLog('db', 'migrate ok');
    } catch (err) {
      debugLog('db', `migrate failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      console.error('[instrumentation] migrate failed:', err);
      throw err;
    }
    try {
      await ensureSeed();
      debugLog('db', 'ensureSeed ok');
    } catch (err) {
      debugLog('db', `ensureSeed failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      console.error('[instrumentation] ensureSeed failed:', err);
      throw err;
    }
  }
}
