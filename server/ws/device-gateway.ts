import { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { getDb } from '@/lib/db/client';
import { devices, deviceSupportedBackends, deviceModels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { hashToken } from '@/lib/auth/token';

interface DeviceConnection {
  ws: WebSocket;
  deviceId: string;
  lastPong: number;
}

const connections = new Map<string, DeviceConnection>();

export function attachDeviceGateway(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (url.pathname !== '/ws/devices') {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // 验证 token
    const tokenHash = hashToken(token);
    const db = getDb();
    db.select().from(devices)
      .where(eq(devices.longLivedTokenHash, tokenHash))
      .limit(1)
      .then(([device]) => {
        if (!device) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req, device.id);
        });
      })
      .catch(() => {
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      });
  });

  wss.on('connection', (ws: WebSocket, req, deviceId: string) => {
    const connection: DeviceConnection = {
      ws,
      deviceId,
      lastPong: Date.now(),
    };
    connections.set(deviceId, connection);

    // 更新设备在线状态
    const db = getDb();
    db.update(devices)
      .set({ online: true, lastSeenAt: new Date() })
      .where(eq(devices.id, deviceId))
      .catch(console.error);

    // 心跳检测
    const heartbeatInterval = setInterval(() => {
      if (Date.now() - connection.lastPong > 90000) {
        // 超时，断开连接
        ws.close(1000, 'Heartbeat timeout');
        connections.delete(deviceId);
        db.update(devices)
          .set({ online: false })
          .where(eq(devices.id, deviceId))
          .catch(console.error);
        clearInterval(heartbeatInterval);
        return;
      }

      // 发送 ping
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);

    ws.on('pong', () => {
      connection.lastPong = Date.now();
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        handleMessage(deviceId, message);
      } catch (error) {
        console.error('Invalid message:', error);
      }
    });

    ws.on('close', () => {
      connections.delete(deviceId);
      db.update(devices)
        .set({ online: false })
        .where(eq(devices.id, deviceId))
        .catch(console.error);
      clearInterval(heartbeatInterval);
    });
  });
}

async function handleMessage(deviceId: string, message: any) {
  const db = getDb();
  
  if (message.type === 'device.hello') {
    const { name, hostname, supportedBackends } = message;
    
    // 更新设备信息
    if (name || hostname) {
      await db.update(devices)
        .set({
          ...(name && { name }),
          ...(hostname && { hostname }),
          lastSeenAt: new Date(),
        })
        .where(eq(devices.id, deviceId));
    }
    
    // 更新 supported backends
    if (supportedBackends && Array.isArray(supportedBackends)) {
      // 先删除旧的
      await db.delete(deviceSupportedBackends)
        .where(eq(deviceSupportedBackends.deviceId, deviceId));
      
      // 插入新的
      for (const backend of supportedBackends) {
        await db.insert(deviceSupportedBackends).values({
          deviceId,
          backend,
        });
      }
    }
  }
  
  if (message.type === 'models.report') {
    const { backend, models } = message;
    // 写入 device_models 表
    const modelsJson = JSON.stringify(models);
    const now = new Date();
    
    // 先删除旧的
    await db.delete(deviceModels)
      .where(and(eq(deviceModels.deviceId, deviceId), eq(deviceModels.backend, backend)));
    
    // 插入新的
    await db.insert(deviceModels).values({
      deviceId,
      backend,
      modelsJson,
      refreshedAt: now,
    });
  }
  
  // 其他消息类型后续处理
}