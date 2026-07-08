import { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { getDb } from '@/lib/db/client';
import { devices, deviceSupportedBackends, deviceModels, sessions, messages } from '@/lib/db/schema';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { hashToken } from '@/lib/auth/token';
import { extractTextFromParts } from '@/lib/backends/persist';
import { sessionEventBus } from '@/lib/events/session-bus';

interface DeviceConnection {
  ws: WebSocket;
  deviceId: string;
  lastPong: number;
}

// globalThis 持有:custom server(tsx server.ts)与 Next.js route handler(turbopack 编译)是两套模块加载器,
// 模块级 const 会各建一份 Map 不共享 -- bridge 连 server.ts 侧 set,route 侧 get 拿空 -> "device not connected"。
// 用 globalThis 保证同进程共享(同 client.ts __dbConn 模式)。
declare global {
  var __deviceConnections: Map<string, DeviceConnection> | undefined;
}
const connections = globalThis.__deviceConnections ?? (globalThis.__deviceConnections = new Map());

// 自动续接阈值：device 重连后，只为 lastActiveAt 距今不到此值的 session 推 session.start
const AUTO_RESUME_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * 向指定设备连接发送一条 WS 消息。
 * 返回 true 表示消息已投递到 OPEN 状态的 socket；false 表示设备未连或 socket 已关闭。
 */
export function sendToDevice(deviceId: string, message: unknown): boolean {
  const conn = connections.get(deviceId);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
    // 诊断:未命中时打印 connections 规模(确认 globalThis 共享是否生效;双实例时 size=0)
    console.log(`[sendToDevice] MISS target=${deviceId} found=${!!conn} readyState=${conn?.ws.readyState} size=${connections.size} keys=[${[...connections.keys()].join(',')}]`);
    return false;
  }
  conn.ws.send(JSON.stringify(message));
  return true;
}

export function attachDeviceGateway(
  server: Server,
  // Next.js 的 WS upgrade 处理器:转交非设备 WS(如 dev 模式 HMR 的 /_next/webpack-hmr),避免被 destroy 导致连接失败
  nextUpgrade?: (req: import('http').IncomingMessage, socket: import('net').Socket, head: Buffer) => void,
) {
  // dev server 重启后内存 connections 清空,但 DB devices.online 仍是旧值(上次 bridge 连接设的 true),
  // 导致"设备在线"假象——route.ts 的 online 校验放行,到 local.ts 才报 "device not connected"。
  // 启动时统一置 false,bridge 重连后 connection 回调(line 92)重新 set true。
  (async () => {
    const db = await getDb();
    await db.update(devices).set({ online: false }).catch(console.error);
  })();

  const wss = new WebSocketServer({ noServer: true });

  // upgrade 回调改为 async：先 await 拿到 db 再做 token 校验 + 查询设备
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (url.pathname !== '/ws/devices') {
      // 非设备 WS(如 Next dev 的 /_next/webpack-hmr):交给 Next 的 upgrade handler,不再 destroy
      if (nextUpgrade) nextUpgrade(req, socket, head);
      else socket.destroy();
      return;
    }

    const token = url.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // 验证 token：用哈希与 devices 表中的 long_lived_token_hash 比对
    const tokenHash = hashToken(token);
    try {
      const db = await getDb();
      const [device] = await db.select().from(devices)
        .where(eq(devices.longLivedTokenHash, tokenHash))
        .limit(1);
      if (!device) {
        console.warn('[device-gateway] WS upgrade rejected: token 不匹配(无对应 device)');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, device.id);
      });
    } catch (error) {
      console.error('WebSocket upgrade error:', error);
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }
  });

  // 连接回调改为 async：在 setup 阶段 await getDb()，后续 setInterval/close 回调闭包引用 db
  wss.on('connection', async (ws: WebSocket, _req: unknown, deviceId: string) => {
    console.log(`[device-gateway] device connected: ${deviceId}`);
    const connection: DeviceConnection = {
      ws,
      deviceId,
      lastPong: Date.now(),
    };
    connections.set(deviceId, connection);

    // 连接建立时获取 db 一次，闭包内统一引用；setInterval/close 回调无法 await，靠 closure 拿到
    const db = await getDb();

    // 更新设备在线状态
    db.update(devices)
      .set({ online: true, lastSeenAt: new Date() })
      .where(eq(devices.id, deviceId))
      .catch(console.error);

    // 自动续接：device 重连后，为该 device 上未完成 session 推 session.start
    // 条件：deletedAt IS NULL + lastActiveAt 距今 < 30 分钟
    // 必须同时通知两条路径：
    //   1. sessionEventBus → 浏览器 SSE（关掉"断连"横幅）
    //   2. sendToDevice → 本地 client（拉起新的 claudecode/pi 子进程，继续当前 turn）
    // 原来只 emit 到 bus，本地 client 永远不会收到 session.start——REV-005-2 修复。
    try {
      const threshold = new Date(Date.now() - AUTO_RESUME_MAX_AGE_MS);
      const resumable = await db.select().from(sessions)
        .where(and(
          eq(sessions.targetId, deviceId),
          isNull(sessions.deletedAt),
          gt(sessions.lastActiveAt, threshold),
        ));
      for (const sess of resumable) {
        // 新 schema 无 content 列,从 parts 提取 text(降级点 #2,完整 parts 见 05 后续 adapter 改造)
        const historyRows = await db.select({ role: messages.role, parts: messages.parts })
          .from(messages)
          .where(eq(messages.sessionId, sess.id))
          .orderBy(messages.seq);
        const startEvent = {
          type: 'session.start' as const,
          sessionId: sess.id,
          backend: sess.backend as 'claudecode' | 'pi',
          model: sess.model,
          history: historyRows
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({ role: m.role, content: extractTextFromParts(m.parts) }))
            .filter((m) => m.content),
          // 透传 backendSessionRef 让 client 走 resume（从 sessions.localSessionRef 读）
          backendSessionRef: sess.localSessionRef ?? undefined,
          // 透传工作目录(auto-resume 也要在原 cwd 续跑)
          cwd: sess.cwd ?? undefined,
        };
        // 1) UI 横幅复位（SSE 通道）
        sessionEventBus.emit(sess.id, startEvent);
        // 2) 本地 client 拉起新进程并喂 history（WS 通道）
        sendToDevice(deviceId, startEvent);
        // 3) 重置 LocalBackend 内存映射（让 send/stop 在新进程就绪后能找到 device）
        //    实际 sendToDevice 已经把命令派给客户端。下一个 turn 发消息时，messages POST
        //    走 router.send → LocalBackend.send(sessionToDevice) — 如果进程被杀过，会抛
        //    "session not started"，前端用 retry 路径重新建连。
      }
    } catch (err) {
      console.error('auto-resume error:', err);
    }

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
      console.log(`[device-gateway] device disconnected: ${deviceId}`);
      connections.delete(deviceId);
      db.update(devices)
        .set({ online: false })
        .where(eq(devices.id, deviceId))
        .catch(console.error);
      clearInterval(heartbeatInterval);

      // 推 session.disconnected 给该 device 上所有未删除的 session（让 UI 显示横幅）
      // reason 取值必须落在协议定义的字面量联合里（device_offline | network | restart），
      // 修复 REV-005-8。
      (async () => {
        const rows = await db.select({ id: sessions.id }).from(sessions)
          .where(and(eq(sessions.targetId, deviceId), isNull(sessions.deletedAt)));
        for (const r of rows) {
          sessionEventBus.emit(r.id, {
            type: 'session.disconnected',
            reason: 'device_offline',
          });
        }
      })().catch((err) => console.error('session.disconnected emit error:', err));
    });
  });
}

async function handleMessage(deviceId: string, message: any) {
  const db = await getDb();

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

  // 本地 client 上行的 session 事件 → 推全局事件总线
  if (message.type === 'session.event' && message.sessionId && message.event) {
    sessionEventBus.emit(message.sessionId, message.event);
  }

  // session.meta：client 上报 backend session 引用，落库 sessions.localSessionRef 做 resume
  if (message.type === 'session.meta' && message.sessionId && message.backendSessionRef) {
    db.update(sessions).set({ localSessionRef: message.backendSessionRef })
      .where(eq(sessions.id, message.sessionId))
      .catch(console.error);
  }
}