import { createServer } from 'http';
import next from 'next';
import { attachDeviceGateway } from './server/ws/device-gateway';

const port = parseInt(process.env.PORT || '3000', 10);
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res));
  // 拿 Next.js 的 WS upgrade 处理器:dev 模式用于 HMR 热更新(连接 /_next/webpack-hmr)
  // 转交给 device-gateway,让非 /ws/devices 的 upgrade 交给 Next 处理,避免被 destroy 导致 HMR 失败
  const nextUpgrade = app.getUpgradeHandler();
  attachDeviceGateway(server, nextUpgrade);
  server.listen(port, () => console.log(`> Webtool on http://localhost:${port}`));
});