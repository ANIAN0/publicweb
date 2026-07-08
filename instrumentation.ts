import { migrate } from './lib/db/client';
import { ensureSeed } from './lib/db/seed';

export async function register() {
  // 确保在Next.js启动时运行迁移 + 种子(预置默认 eve 服务)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 代理支持:Node 原生 fetch(undici)不读 HTTP_PROXY/HTTPS_PROXY 环境变量,
    // 需显式 setGlobalDispatcher(ProxyAgent);否则 webtool 访问需代理的云端 eve(Vercel/hf.space)
    // 会超时,probe 静默 return false,表现为"连不上且无报错"(AGENTS.md §13:日志可定位)
    // 动态 import + try/catch:未装 undici 时不崩,仅打错误日志提示 `pnpm add undici`
    const proxyUrl =
      process.env.HTTPS_PROXY || process.env.HTTP_PROXY ||
      process.env.https_proxy || process.env.http_proxy;
    if (proxyUrl) {
      try {
        const { ProxyAgent, setGlobalDispatcher } = await import('undici');
        setGlobalDispatcher(new ProxyAgent(proxyUrl));
        console.log(`[instrumentation] 全局代理已启用: ${proxyUrl}`);
      } catch (err) {
        console.error(`[instrumentation] 代理启用失败(需 pnpm add undici):`, err);
      }
    }
    await migrate();
    await ensureSeed();
  }
}