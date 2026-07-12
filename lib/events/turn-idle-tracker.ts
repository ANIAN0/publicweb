/**
 * C-005 / T-006：Idle 超时（工具 10m / turn 60m，按无新事件计时，非挂钟）。
 * 通过 settleTurnInterrupted 统一执行幂等终态结算。
 *
 * env：
 *   WEBTOOL_TOOL_IDLE_MS   默认 600000（10min）
 *   WEBTOOL_TURN_IDLE_MS   默认 3600000（60min）
 */
import { settleTurnInterrupted } from '@/lib/backends/persist';
import { debugLog } from '@/lib/debug-log';
import type { WebtoolEvent } from '@/lib/protocol/events';
import { isLegacyPartEvent } from '@/lib/protocol/events';

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const TOOL_IDLE_MS = envMs('WEBTOOL_TOOL_IDLE_MS', 10 * 60_000);
export const TURN_IDLE_MS = envMs('WEBTOOL_TURN_IDLE_MS', 60 * 60_000);

type TurnIdleState = {
  sessionId: string;
  lastEventAt: number;
  /** 打开中的 toolCallId 集合（有工具无终态则计 tool idle） */
  openTools: Set<string>;
  /** 工具最后相关事件时间 */
  lastToolEventAt: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __turnIdleMap: Map<string, TurnIdleState> | undefined;
  // eslint-disable-next-line no-var
  var __turnIdleTimer: ReturnType<typeof setInterval> | undefined;
}

function idleMap(): Map<string, TurnIdleState> {
  if (!global.__turnIdleMap) global.__turnIdleMap = new Map();
  return global.__turnIdleMap;
}

function isTerminal(event: WebtoolEvent): boolean {
  if (isLegacyPartEvent(event) && event.type === 'turn.completed') return true;
  const t = (event as { type?: string }).type;
  return t === 'finish' || t === 'abort' || t === 'error';
}

function toolOpenId(event: WebtoolEvent): string | null {
  const t = (event as { type?: string; toolCallId?: string }).type;
  const id = (event as { toolCallId?: string }).toolCallId;
  if (!id) return null;
  if (
    t === 'tool-input-start' ||
    t === 'tool-input-available' ||
    t === 'tool-approval-request'
  ) {
    return id;
  }
  return null;
}

function toolCloseId(event: WebtoolEvent): string | null {
  const t = (event as { type?: string; toolCallId?: string }).type;
  const id = (event as { toolCallId?: string }).toolCallId;
  if (!id) return null;
  if (
    t === 'tool-output-available' ||
    t === 'tool-output-error' ||
    t === 'tool-output-denied' ||
    t === 'tool-input-error'
  ) {
    // preliminary output 不算关闭
    if (t === 'tool-output-available' && (event as { preliminary?: boolean }).preliminary) {
      return null;
    }
    return id;
  }
  return null;
}

/** 入站事件：刷新 lastEventAt / 工具集合 */
export function noteTurnEvent(sessionId: string, event: WebtoolEvent): void {
  if (isTerminal(event)) {
    idleMap().delete(sessionId);
    return;
  }
  const now = Date.now();
  let s = idleMap().get(sessionId);
  if (!s) {
    s = {
      sessionId,
      lastEventAt: now,
      openTools: new Set(),
      lastToolEventAt: now,
    };
    idleMap().set(sessionId, s);
  }
  s.lastEventAt = now;
  const openId = toolOpenId(event);
  if (openId) {
    s.openTools.add(openId);
    s.lastToolEventAt = now;
  }
  const closeId = toolCloseId(event);
  if (closeId) {
    s.openTools.delete(closeId);
    s.lastToolEventAt = now;
  }
}

/** 中心 send 时登记 turn 开始 */
export function beginTurnIdle(sessionId: string): void {
  const now = Date.now();
  idleMap().set(sessionId, {
    sessionId,
    lastEventAt: now,
    openTools: new Set(),
    lastToolEventAt: now,
  });
}

export function endTurnIdle(sessionId: string): void {
  idleMap().delete(sessionId);
}

async function sweepIdle(): Promise<void> {
  const now = Date.now();
  for (const s of [...idleMap().values()]) {
    // 工具 idle：有打开工具且工具相关无进展
    if (s.openTools.size > 0 && now - s.lastToolEventAt >= TOOL_IDLE_MS) {
      debugLog(
        'local',
        `tool idle sid=${s.sessionId} open=${s.openTools.size} idleMs=${TOOL_IDLE_MS}`,
      );
      try {
        await settleTurnInterrupted(s.sessionId, 'error', {
          code: 'tool_idle_timeout',
          message: `tool idle exceeded ${TOOL_IDLE_MS}ms`,
        });
        const { sessionEventBus } = await import('./session-bus');
        sessionEventBus.emit(s.sessionId, {
          type: 'error',
          errorText: `tool_idle_timeout: tool idle exceeded ${TOOL_IDLE_MS}ms`,
        });
      } catch (err) {
        debugLog(
          'local',
          `tool idle settle failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      idleMap().delete(s.sessionId);
      continue;
    }
    // turn idle：无任何新事件
    if (now - s.lastEventAt >= TURN_IDLE_MS) {
      debugLog('local', `turn idle sid=${s.sessionId} idleMs=${TURN_IDLE_MS}`);
      try {
        await settleTurnInterrupted(s.sessionId, 'interrupted', {
          code: 'turn_idle_timeout',
          message: `turn idle exceeded ${TURN_IDLE_MS}ms`,
        });
        const { sessionEventBus } = await import('./session-bus');
        sessionEventBus.emit(s.sessionId, {
          type: 'abort',
          reason: 'turn_idle_timeout',
        });
      } catch (err) {
        debugLog(
          'local',
          `turn idle settle failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      idleMap().delete(s.sessionId);
    }
  }
}

export function ensureTurnIdleTimer(): void {
  if (global.__turnIdleTimer) return;
  const interval = Math.max(5_000, Math.min(TOOL_IDLE_MS, TURN_IDLE_MS) / 6);
  global.__turnIdleTimer = setInterval(() => {
    void sweepIdle();
  }, interval);
  if (typeof global.__turnIdleTimer === 'object' && 'unref' in global.__turnIdleTimer) {
    (global.__turnIdleTimer as NodeJS.Timeout).unref?.();
  }
}

if (typeof setInterval !== 'undefined') {
  ensureTurnIdleTimer();
}
