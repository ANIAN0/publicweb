import { createServer } from 'http';
import next from 'next';
import { attachDeviceGateway } from './server/ws/device-gateway';
import { debugLog } from './lib/debug-log';

const port = parseInt(process.env.PORT || '3000', 10);
// 默认仅本机回环：与「本地信任」威胁模型一致；需局域网访问时显式设 HOST=0.0.0.0
const host = process.env.HOST || '127.0.0.1';
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev, hostname: host, port });
const handle = app.getRequestHandler();

// WS-017：进程级错误落本地日志，避免静默崩溃
process.on('uncaughtException', (err) => {
  debugLog('app', `uncaughtException: ${err?.stack ?? err?.message ?? String(err)}`);
  console.error('[server] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  debugLog('app', `unhandledRejection: ${msg}`);
  console.error('[server] unhandledRejection:', reason);
});

app.prepare().then(() => {
  // WS-019：handler 显式命名，避免过度闭包
  function requestHandler(
    req: import('http').IncomingMessage,
    res: import('http').ServerResponse,
  ) {
    void handle(req, res);
  }
  const server = createServer(requestHandler);
  // 拿 Next.js 的 WS upgrade 处理器:dev 模式用于 HMR 热更新(连接 /_next/webpack-hmr)
  // 转交给 device-gateway,让非 /ws/devices 的 upgrade 交给 Next 处理,避免被 destroy 导致 HMR 失败
  const nextUpgrade = app.getUpgradeHandler();
  attachDeviceGateway(server, nextUpgrade);
  // WS-018：listen 与 hostname/port 一致
  server.listen(port, host, () => {
    debugLog('app', `listen host=${host} port=${port}`);
    console.log(`> Webtool on http://${host}:${port} (set HOST=0.0.0.0 to listen all interfaces)`);
  });
});
