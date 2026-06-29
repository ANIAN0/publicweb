import { createServer, Server } from 'http';
import { attachDeviceGateway } from '../../server/ws/device-gateway';
import { getDb, migrate } from '../../lib/db/client';
import { devices, deviceSupportedBackends } from '../../lib/db/schema';
import { hashToken, generateToken } from '../../lib/auth/token';
import { ulid } from 'ulid';

let server: Server | null = null;

export async function startTestServer() {
  process.env.DATABASE_URL = 'file::memory:?cache=shared';
  await migrate();
  
  const port = Math.floor(Math.random() * 10000) + 30000;
  
  server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  });
  attachDeviceGateway(server);
  
  await new Promise<void>((resolve) => {
    server!.listen(port, () => resolve());
  });
  
  // 创建测试设备和 token
  const db = getDb();
  const deviceId = ulid();
  const longLivedToken = generateToken();
  const longLivedTokenHash = hashToken(longLivedToken);
  const now = new Date();
  
  await db.insert(devices).values({
    id: deviceId,
    name: 'test-device',
    hostname: 'localhost',
    longLivedTokenHash,
    lastSeenAt: now,
    online: true,
    createdAt: now,
  });
  
  await db.insert(deviceSupportedBackends).values({
    deviceId,
    backend: 'claudecode',
  });
  
  return {
    port,
    wsUrl: `ws://localhost:${port}/ws/devices`,
    httpUrl: `http://localhost:${port}`,
    deviceId,
    longLivedToken,
  };
}

export async function stopTestServer() {
  if (server) {
    server.close();
    server = null;
  }
}