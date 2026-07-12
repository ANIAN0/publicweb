import { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { getDb } from '@/lib/db/client';
import { devices, deviceSupportedBackends, deviceModels, sessions, deviceErrors } from '@/lib/db/schema';
import { eq, and, isNull, gt, or } from 'drizzle-orm';
import { hashToken } from '@/lib/auth/token';
import { loadConversationHistory } from '@/lib/chat/history';
import { sessionEventBus } from '@/lib/events/session-bus';
import { ulid } from 'ulid';
import {
  sendToDevice,
  setDeviceConnection,
  removeDeviceConnectionIfCurrent,
  type DeviceConnection,
} from './device-connections';
import { getBackendAdapter } from '@/lib/backends/router';
import type { LocalBackend } from '@/lib/backends/local';
import { isPendingStale } from '@/lib/backends/pending';
import { debugLog } from '@/lib/debug-log';
import { isLocalBackendId } from '@/lib/backends/labels';
import {
  isStreamContentEnvelope,
  normalizeSessionEventPayload,
  type StreamContentEnvelope,
  type WebtoolEvent,
} from '@/lib/protocol/events';
import { generationStream } from '@/lib/events/generation-stream';
import { releaseTurnLock } from '@/lib/backends/turn-lock';

// 自动续接窗口：仅处理最近活跃 session（WS-005 集中常量）
const AUTO_RESUME_MAX_AGE_MS = 30 * 60 * 1000;
// 心跳超时后 terminate 兜底延迟（WS-011）
const HEARTBEAT_TERMINATE_MS = 2000;
// WS-015：应用级 device.heartbeat 刷新 DB lastSeenAt；协议级 ping/pong 检测僵死 socket。
// 二者职责不同：ping/pong 看 TCP 活着；heartbeat 带 sessionCount/models 健康快照。

// WS-010：业务入口统一从 device-connections 导入；此处 re-export 保持旧路径兼容
export { sendToDevice } from './device-connections';

export function attachDeviceGateway(
  server: Server,
  // Next.js 的 WS upgrade 处理器:转交非设备 WS(如 dev 模式 HMR 的 /_next/webpack-hmr)
  // socket 在 Node 类型里常为 Duplex，与 net.Socket 略有差异，用宽类型兼容
  nextUpgrade?: (
    req: import('http').IncomingMessage,
    socket: import('stream').Duplex,
    head: Buffer,
  ) => void,
) {
  // 启动时清 online 假象（内存 connections 已空，DB 可能仍 true）
  // WS-008：全表 update 可接受——仅启动一次；失败打日志不阻塞 gateway 挂载
  (async () => {
    try {
      const db = await getDb();
      await db.update(devices).set({ online: false });
      debugLog('ws', 'startup: marked all devices offline');
    } catch (err) {
      debugLog('ws', `startup online=false failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error('[device-gateway] startup online reset failed:', err);
    }
  })();

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (url.pathname !== '/ws/devices') {
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

  wss.on('connection', async (ws: WebSocket, _req: unknown, deviceId: string) => {
    console.log(`[device-gateway] device connected: ${deviceId}`);
    debugLog('ws', `device connected deviceId=${deviceId}`);
    const connection: DeviceConnection = {
      ws,
      deviceId,
      lastPong: Date.now(),
    };

    // WS-001：先挂 close/error/heartbeat，再 await DB / auto-resume
    // 保证登记与生命周期对称；getDb 失败时仍能对称清理
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let cleaned = false;

    const cleanup = (reason: string) => {
      if (cleaned) return;
      cleaned = true;
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      const removed = removeDeviceConnectionIfCurrent(deviceId, ws);
      debugLog('ws', `cleanup deviceId=${deviceId} reason=${reason} removed=${removed}`);
      if (!removed) return;
      void (async () => {
        try {
          const db = await getDb();
          await db.update(devices).set({ online: false }).where(eq(devices.id, deviceId));
          const rows = await db.select({ id: sessions.id }).from(sessions)
            .where(and(eq(sessions.targetId, deviceId), isNull(sessions.deletedAt)));
          for (const r of rows) {
            // cleanup 入参为 string；映射到 SessionLifecycleEvent 的 reason 联合
            const disconnectReason =
              reason === 'close' || reason === 'device_offline'
                ? ('device_offline' as const)
                : reason === 'ws_error'
                  ? ('ws_error' as const)
                  : reason === 'heartbeat_timeout'
                    ? ('heartbeat_timeout' as const)
                    : reason === 'getDb_failed'
                      ? ('getDb_failed' as const)
                      : reason === 'resume_failed'
                        ? ('resume_failed' as const)
                        : reason === 'network'
                          ? ('network' as const)
                          : reason === 'restart'
                            ? ('restart' as const)
                            : ('device_offline' as const);
            sessionEventBus.emit(r.id, {
              type: 'session.disconnected',
              reason: disconnectReason,
            });
          }
        } catch (err) {
          debugLog('ws', `cleanup db failed deviceId=${deviceId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    };

    // 踢旧连 + 登记；旧 close 用 removeIfCurrent 不会误删本连接
    setDeviceConnection(deviceId, connection);

    heartbeatInterval = setInterval(() => {
      if (Date.now() - connection.lastPong > 90000) {
        debugLog('ws', `heartbeat timeout deviceId=${deviceId}`);
        try {
          ws.close(1000, 'Heartbeat timeout');
        } catch {
          /* ignore */
        }
        // WS-011：close 后短延迟仍 OPEN 则 terminate
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
            try {
              ws.terminate();
            } catch {
              /* ignore */
            }
          }
          cleanup('heartbeat_timeout');
        }, HEARTBEAT_TERMINATE_MS);
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);

    ws.on('pong', () => {
      connection.lastPong = Date.now();
    });

    // WS-002：监听 error，对称清理
    ws.on('error', (err) => {
      debugLog('ws', `ws error deviceId=${deviceId} err=${err?.message ?? String(err)}`);
      console.error(`[device-gateway] ws error deviceId=${deviceId}:`, err);
      cleanup('ws_error');
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        void handleMessage(deviceId, message).catch((err) => {
          debugLog('ws', `message handler failed deviceId=${deviceId}: ${err instanceof Error ? err.message : String(err)}`);
          console.error(`[device-gateway] message handler failed deviceId=${deviceId}:`, err);
        });
      } catch (error) {
        // WS-007：记录原始片段便于排障
        const raw = typeof data === 'string' ? data : data.toString().slice(0, 200);
        debugLog('ws', `invalid message deviceId=${deviceId} raw=${raw}`);
        console.error('Invalid message:', error);
      }
    });

    ws.on('close', () => {
      console.log(`[device-gateway] device disconnected: ${deviceId}`);
      cleanup('close');
    });

    // 登记 handler 后再 await DB（失败路径 cleanup 已挂好）
    let db: Awaited<ReturnType<typeof getDb>>;
    try {
      db = await getDb();
    } catch (err) {
      debugLog('ws', `getDb failed after connect deviceId=${deviceId}: ${err instanceof Error ? err.message : String(err)}`);
      console.error('[device-gateway] getDb failed after connect:', err);
      cleanup('getDb_failed');
      try {
        ws.close(1011, 'server db unavailable');
      } catch {
        /* ignore */
      }
      return;
    }

    db.update(devices)
      .set({ online: true, lastSeenAt: new Date() })
      .where(eq(devices.id, deviceId))
      .catch((err) => {
        debugLog('ws', `online=true update failed deviceId=${deviceId}: ${err instanceof Error ? err.message : String(err)}`);
        console.error(err);
      });

    // 自动续接（WS-004：单 session 失败可观测，不静默）
    try {
      await autoResumeSessions(db, deviceId);
    } catch (err) {
      debugLog('ws', `auto-resume top-level error deviceId=${deviceId}: ${err instanceof Error ? err.message : String(err)}`);
      console.error('auto-resume error:', err);
    }
  });
}

/**
 * 自动续接设备上最近活跃的 local session。
 * WS-004：bindRuntime 或 start 下发失败时 emit session.disconnected(resume_failed)，禁止半成功静默。
 */
async function autoResumeSessions(
  db: Awaited<ReturnType<typeof getDb>>,
  deviceId: string,
): Promise<void> {
  const threshold = new Date(Date.now() - AUTO_RESUME_MAX_AGE_MS);
  // WS-006：用 isLocalBackendId 语义；SQL 仍列 local backend（drizzle or 需显式）
  const candidates = await db.select().from(sessions)
    .where(and(
      eq(sessions.targetId, deviceId),
      isNull(sessions.deletedAt),
      gt(sessions.lastActiveAt, threshold),
      or(
        eq(sessions.backend, 'claudecode'),
        eq(sessions.backend, 'pi'),
      ),
    ));

  debugLog('ws', `auto-resume candidates deviceId=${deviceId} count=${candidates.length}`);

  for (const sess of candidates) {
    try {
      if (sess.pendingUserMessage) {
        const stale = await isPendingStale(sess.id);
        if (stale) {
          await db.update(sessions).set({
            pendingUserMessage: null,
            pendingUserMessageCreatedAt: null,
          }).where(eq(sessions.id, sess.id));
          await releaseTurnLock(sess.id);
        }
      }

      // 挂 persist + 映射
      const adapter = getBackendAdapter(sess.backend) as LocalBackend;
      if (typeof adapter.bindRuntime !== 'function') {
        throw new Error(`bindRuntime missing on backend=${sess.backend}`);
      }
      adapter.bindRuntime(sess.id, deviceId);

      // APP-008：复用 history helper
      const history = await loadConversationHistory(sess.id);
      const startEvent = {
        type: 'session.start' as const,
        sessionId: sess.id,
        backend: sess.backend as 'claudecode' | 'pi',
        model: sess.model,
        history,
        backendSessionRef: sess.localSessionRef ?? undefined,
        cwd: sess.cwd ?? undefined,
      };
      // 1) UI 横幅复位
      sessionEventBus.emit(sess.id, startEvent);
      // 2) client 拉起进程
      const ok = sendToDevice(deviceId, startEvent);
      if (!ok) {
        throw new Error('sendToDevice failed: device not connected');
      }
      debugLog('ws', `auto-resume ok sid=${sess.id} deviceId=${deviceId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog('ws', `auto-resume failed sid=${sess.id} deviceId=${deviceId} err=${msg}`);
      console.error(`[device-gateway] auto-resume failed sid=${sess.id}:`, err);
      // 统一失败语义：通知 UI resume 失败，避免半成功静默
      sessionEventBus.emit(sess.id, {
        type: 'session.disconnected',
        reason: 'resume_failed',
      });
    }
  }
}

/**
 * 校验 session 归属本 device；非本设备会话拒绝 event/meta
 */
async function assertSessionOwnedByDevice(
  db: Awaited<ReturnType<typeof getDb>>,
  sessionId: string,
  deviceId: string,
): Promise<boolean> {
  const [row] = await db.select({ targetId: sessions.targetId, backend: sessions.backend })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) {
    console.warn(`[device-gateway] reject: unknown sessionId=${sessionId} from device=${deviceId}`);
    return false;
  }
  if (row.targetId !== deviceId) {
    console.warn(
      `[device-gateway] reject: session ${sessionId} target=${row.targetId} != device=${deviceId}`,
    );
    return false;
  }
  if (!isLocalBackendId(row.backend)) {
    console.warn(`[device-gateway] reject: session ${sessionId} backend=${row.backend} not local`);
    return false;
  }
  return true;
}

// ── WS-003：handleMessage 按 type 拆到独立 handler，主函数只分发 ──

type Db = Awaited<ReturnType<typeof getDb>>;

async function handleDeviceHello(db: Db, deviceId: string, msg: Record<string, unknown>) {
  const name = typeof msg.name === 'string' ? msg.name : undefined;
  const hostname = typeof msg.hostname === 'string' ? msg.hostname : undefined;
  const supportedBackends = msg.supportedBackends;

  if (name || hostname) {
    await db.update(devices)
      .set({
        ...(name && { name }),
        ...(hostname && { hostname }),
        lastSeenAt: new Date(),
      })
      .where(eq(devices.id, deviceId));
  }

  if (supportedBackends && Array.isArray(supportedBackends)) {
    await db.delete(deviceSupportedBackends)
      .where(eq(deviceSupportedBackends.deviceId, deviceId));

    for (const backend of supportedBackends) {
      if (typeof backend !== 'string') continue;
      await db.insert(deviceSupportedBackends).values({
        deviceId,
        backend,
      });
    }
  }
}

async function handleModelsReport(db: Db, deviceId: string, msg: Record<string, unknown>) {
  const backend = String(msg.backend ?? '');
  const modelsJson = JSON.stringify(msg.models ?? []);
  const now = new Date();

  await db.delete(deviceModels)
    .where(and(eq(deviceModels.deviceId, deviceId), eq(deviceModels.backend, backend)));

  await db.insert(deviceModels).values({
    deviceId,
    backend,
    modelsJson,
    refreshedAt: now,
  });
}

async function handleSessionEvent(db: Db, deviceId: string, msg: Record<string, unknown>) {
  if (typeof msg.sessionId !== 'string' || !msg.event) return;
  const sessionId = msg.sessionId;
  const owned = await assertSessionOwnedByDevice(db, sessionId, deviceId);
  if (!owned) return;
  try {
    const [sess] = await db.select({ backend: sessions.backend })
      .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (sess && isLocalBackendId(sess.backend)) {
      const adapter = getBackendAdapter(sess.backend) as LocalBackend;
      if (typeof adapter.bindRuntime === 'function') {
        adapter.bindRuntime(sessionId, deviceId);
      }
    }
  } catch (err) {
    console.error('[device-gateway] bindRuntime on event failed:', err);
  }
  // C-001：信封 { runId, chunk } 归一为扁平 chunk 进总线；legacy part.* 原样（过渡）
  const raw = msg.event as StreamContentEnvelope | WebtoolEvent;
  let runIdHint: string | undefined;
  if (isStreamContentEnvelope(raw)) {
    runIdHint = raw.runId;
    // 中心绑定 session→runId，供无信封的后续 legacy 事件续缓冲
    generationStream.bindSessionRun(sessionId, raw.runId);
  }
  const flat = normalizeSessionEventPayload(raw);
  sessionEventBus.emit(sessionId, flat, runIdHint);
}

async function handleSessionMeta(db: Db, deviceId: string, msg: Record<string, unknown>) {
  if (typeof msg.sessionId !== 'string' || !msg.backendSessionRef) return;
  const sessionId = msg.sessionId;
  const backendSessionRef = String(msg.backendSessionRef);
  const metaId = typeof msg.metaId === 'string' ? msg.metaId : undefined;

  const owned = await assertSessionOwnedByDevice(db, sessionId, deviceId);
  if (!owned) {
    sendToDevice(deviceId, {
      type: 'session.meta.ack',
      sessionId,
      backendSessionRef,
      metaId,
      ok: false,
      error: 'session not owned by this device',
    });
    return;
  }

  try {
    await db.update(sessions)
      .set({ localSessionRef: backendSessionRef })
      .where(and(eq(sessions.id, sessionId), eq(sessions.targetId, deviceId)));
    sendToDevice(deviceId, {
      type: 'session.meta.ack',
      sessionId,
      backendSessionRef,
      metaId,
      ok: true,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[device-gateway] session.meta persist failed sid=${sessionId}:`, err);
    sendToDevice(deviceId, {
      type: 'session.meta.ack',
      sessionId,
      backendSessionRef,
      metaId,
      ok: false,
      error: errMsg,
    });
  }
}

async function handleDeviceHeartbeat(db: Db, deviceId: string, msg: Record<string, unknown>) {
  const health = {
    sessionCount: Number(msg.sessionCount) || 0,
    uptimeMs: Number(msg.uptimeMs) || 0,
    modelsCount: msg.modelsCount != null ? Number(msg.modelsCount) : undefined,
    lastError: msg.lastError ?? null,
    at: new Date().toISOString(),
  };
  await db.update(devices)
    .set({
      online: true,
      lastSeenAt: new Date(),
      healthJson: JSON.stringify(health),
    })
    .where(eq(devices.id, deviceId));
}

async function handleDeviceError(db: Db, deviceId: string, msg: Record<string, unknown>) {
  if (!msg.code || !msg.message) return;
  await db.insert(deviceErrors).values({
    id: ulid(),
    deviceId,
    code: String(msg.code),
    message: String(msg.message).slice(0, 2000),
    category: msg.category ? String(msg.category) : null,
    sessionId: msg.sessionId ? String(msg.sessionId) : null,
    stack: msg.stack ? String(msg.stack).slice(0, 8000) : null,
    contextJson: msg.context ? JSON.stringify(msg.context).slice(0, 8000) : null,
    createdAt: new Date(),
  });
  await db.update(devices)
    .set({ lastSeenAt: new Date() })
    .where(eq(devices.id, deviceId));
}

async function handleMessage(deviceId: string, message: unknown) {
  const db = await getDb();
  // WS-014：收窄 any，运行时按 type 分发
  if (!message || typeof message !== 'object') return;
  const msg = message as Record<string, unknown>;
  const type = msg.type;

  if (type === 'device.hello') return handleDeviceHello(db, deviceId, msg);
  if (type === 'models.report') return handleModelsReport(db, deviceId, msg);
  if (type === 'session.event') return handleSessionEvent(db, deviceId, msg);
  if (type === 'session.meta') return handleSessionMeta(db, deviceId, msg);
  if (type === 'device.heartbeat') return handleDeviceHeartbeat(db, deviceId, msg);
  if (type === 'device.error') return handleDeviceError(db, deviceId, msg);
}
