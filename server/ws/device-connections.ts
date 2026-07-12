// 设备 WS 连接表：与 device-gateway 业务逻辑分离，避免 local ↔ gateway 循环依赖
// custom server 与 Next route 双加载器用 globalThis 共享同一 Map
//
// WS-012：globalThis Map 假设单 Node 进程（custom server + turbopack 同进程）。
// 多进程/集群需外置连接注册表——当前架构刻意单进程，禁止在未改造前水平扩展 WS。
import { WebSocket } from 'ws';

export interface DeviceConnection {
  ws: WebSocket;
  deviceId: string;
  lastPong: number;
}

declare global {
  // 同进程共享：tsx server 与 turbopack route 各有模块副本时仍指向同一 Map
  var __deviceConnections: Map<string, DeviceConnection> | undefined;
  // WS-013：MISS 日志节流时间戳
  var __sendToDeviceMissAt: Map<string, number> | undefined;
}

const connections =
  globalThis.__deviceConnections ?? (globalThis.__deviceConnections = new Map());

const missLogAt =
  globalThis.__sendToDeviceMissAt ?? (globalThis.__sendToDeviceMissAt = new Map());

/** 同一 deviceId 的 MISS 日志最少间隔（ms） */
const MISS_LOG_THROTTLE_MS = 5_000;

/**
 * 向指定设备发送一条 WS 消息。
 * @returns true=已写入 OPEN socket；false=未连接或已关闭
 */
export function sendToDevice(deviceId: string, message: unknown): boolean {
  const conn = connections.get(deviceId);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
    // WS-013：节流，避免 send 失败路径刷屏
    const now = Date.now();
    const last = missLogAt.get(deviceId) ?? 0;
    if (now - last >= MISS_LOG_THROTTLE_MS) {
      missLogAt.set(deviceId, now);
      console.log(
        `[sendToDevice] MISS target=${deviceId} found=${!!conn} readyState=${conn?.ws.readyState} size=${connections.size} keys=[${[...connections.keys()].join(',')}]`,
      );
    }
    return false;
  }
  conn.ws.send(JSON.stringify(message));
  return true;
}

/** 当前登记的连接（可能已关闭，调用方自行看 readyState） */
export function getDeviceConnection(deviceId: string): DeviceConnection | undefined {
  return connections.get(deviceId);
}

/**
 * 登记新连接：若已有旧 socket，先关闭旧连接（close 回调须用 removeIfCurrent 防误删新连接）
 * WS-009 invariant：Map 中每个 deviceId 至多一条活连接；替换时先 close 旧 ws。
 */
export function setDeviceConnection(deviceId: string, connection: DeviceConnection): void {
  const prev = connections.get(deviceId);
  if (prev && prev.ws !== connection.ws) {
    try {
      // 踢旧连接，避免双活；旧 close 不会删掉新 Map 项（见 removeIfCurrent）
      prev.ws.close(1000, 'replaced by new connection');
    } catch {
      /* 忽略关闭失败 */
    }
  }
  connections.set(deviceId, connection);
}

/**
 * 仅当 Map 中仍是该 ws 时删除并返回 true。
 * 防止：A 连接 → B 替换 A → A 的 close 误删 B。
 */
export function removeDeviceConnectionIfCurrent(
  deviceId: string,
  ws: WebSocket,
): boolean {
  const cur = connections.get(deviceId);
  if (!cur || cur.ws !== ws) return false;
  connections.delete(deviceId);
  return true;
}
