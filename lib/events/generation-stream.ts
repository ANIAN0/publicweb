/**
 * C-011 / T-002b：中心生成流缓冲（展示续接，非第二权威库）。
 *
 * - 键：中心分配的 runId
 * - 单调 seq（turn 内从 1 递增，仅中心赋值）
 * - subscribe(runId, afterSeq)：先回放再实时
 * - 结束后 retention，再丢弃缓冲
 *
 * **禁止** 向 persist 导出 parts 快照；interrupt partial 只走 T-002 自持状态。
 *
 * env 覆盖（测试缩短）：
 *   WEBTOOL_GEN_RETENTION_MS  默认 900000（15min）
 *   WEBTOOL_GEN_BUFFER_LIMIT  默认 2000
 */
import type { WebtoolEvent } from '@/lib/protocol/events';
import { isLegacyPartEvent } from '@/lib/protocol/events';
import { debugLog } from '@/lib/debug-log';

// ---------------------------------------------------------------------------
// 配置（env 可覆盖）
// ---------------------------------------------------------------------------

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** turn 结束后缓冲保留 */
export const GEN_RETENTION_MS = envMs('WEBTOOL_GEN_RETENTION_MS', 15 * 60_000);
/** 单 run 缓冲上限 */
const GEN_BUFFER_LIMIT = (() => {
  const raw = process.env.WEBTOOL_GEN_BUFFER_LIMIT?.trim();
  if (!raw) return 2000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 2000;
})();

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type GenerationStreamItem = {
  seq: number;
  runId: string;
  sessionId: string;
  event: WebtoolEvent;
  at: number;
};

type RunSubscriber = (item: GenerationStreamItem) => void;

type RunBuffer = {
  runId: string;
  sessionId: string;
  /** 下一 seq（已发布最大 + 1） */
  nextSeq: number;
  items: GenerationStreamItem[];
  /** 是否已终态（finish/abort 等） */
  ended: boolean;
  /** 终态后丢弃时刻；未结束为 null */
  discardAt: number | null;
  subscribers: Set<RunSubscriber>;
};

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __generationStream: GenerationStreamRegistry | undefined;
  // eslint-disable-next-line no-var
  var __generationStreamRetentionTimer: ReturnType<typeof setInterval> | undefined;
  // sessionId → 当前活跃 runId（中心 send 时登记）
  // eslint-disable-next-line no-var
  var __sessionActiveRunId: Map<string, string> | undefined;
}

function activeRunMap(): Map<string, string> {
  if (!global.__sessionActiveRunId) {
    global.__sessionActiveRunId = new Map();
  }
  return global.__sessionActiveRunId;
}

export class GenerationStreamRegistry {
  private runs = new Map<string, RunBuffer>();

  /** 中心 send 时打开/绑定 run */
  openRun(sessionId: string, runId: string): void {
    activeRunMap().set(sessionId, runId);
    let run = this.runs.get(runId);
    if (!run) {
      run = {
        runId,
        sessionId,
        nextSeq: 1,
        items: [],
        ended: false,
        discardAt: null,
        subscribers: new Set(),
      };
      this.runs.set(runId, run);
      debugLog('local', `gen-stream open runId=${runId} sid=${sessionId}`);
    } else {
      run.sessionId = sessionId;
      run.ended = false;
      run.discardAt = null;
    }
  }

  /** 查询 session 当前活跃 runId */
  getActiveRunId(sessionId: string): string | undefined {
    return activeRunMap().get(sessionId);
  }

  /** 绑定 session → runId（不重置缓冲） */
  bindSessionRun(sessionId: string, runId: string): void {
    activeRunMap().set(sessionId, runId);
  }

  /**
   * 发布事件：赋单调 seq，入缓冲，fan-out 订阅者。
   * @returns seq；无 run 时返回 0（不缓冲）
   */
  publish(sessionId: string, event: WebtoolEvent, runIdHint?: string): number {
    const runId = runIdHint ?? activeRunMap().get(sessionId);
    if (!runId) return 0;

    let run = this.runs.get(runId);
    if (!run) {
      this.openRun(sessionId, runId);
      run = this.runs.get(runId)!;
    }

    if (run.ended) {
      // 终态后仍可能有迟到事件：忽略或轻量记日志
      return 0;
    }

    const seq = run.nextSeq++;
    const item: GenerationStreamItem = {
      seq,
      runId,
      sessionId,
      event,
      at: Date.now(),
    };
    run.items.push(item);
    if (run.items.length > GEN_BUFFER_LIMIT) {
      run.items.shift();
    }

    for (const cb of run.subscribers) {
      try {
        cb(item);
      } catch {
        /* 单订阅者失败不影响 */
      }
    }

    // 终态事件 → 进入 retention
    if (isTerminalEvent(event)) {
      this.endRun(runId);
    }

    return seq;
  }

  /**
   * 订阅：先回放 seq > afterSeq，再收实时。
   * afterSeq 默认 0 = 从开头回放缓冲内全部。
   */
  subscribe(runId: string, afterSeq: number, cb: RunSubscriber): () => void {
    const run = this.runs.get(runId);
    if (!run) {
      // 无缓冲：空订阅（调用方可再挂 session bus）
      return () => {};
    }
    const from = Number.isFinite(afterSeq) ? afterSeq : 0;
    for (const item of run.items) {
      if (item.seq > from) {
        try {
          cb(item);
        } catch {
          /* ignore */
        }
      }
    }
    run.subscribers.add(cb);
    return () => {
      run.subscribers.delete(cb);
    };
  }

  /** turn 终态：开始 retention 计时 */
  endRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (!run.ended) {
      run.ended = true;
      run.discardAt = Date.now() + GEN_RETENTION_MS;
      debugLog(
        'local',
        `gen-stream end runId=${runId} retentionMs=${GEN_RETENTION_MS}`,
      );
    }
    // 清 session 活跃映射（同 session 下一 turn 会 open 新 run）
    const cur = activeRunMap().get(run.sessionId);
    if (cur === runId) {
      activeRunMap().delete(run.sessionId);
    }
  }

  /** 清理已结束且超过 retention 的展示缓冲；不终止仍在运行的 turn。 */
  sweepRetention(): void {
    const now = Date.now();
    for (const run of this.runs.values()) {
      if (run.ended && run.discardAt !== null && now >= run.discardAt) {
        this.runs.delete(run.runId);
        debugLog('local', `gen-stream discard runId=${run.runId}`);
      }
    }
  }

  /** 测试/观测 */
  getRun(runId: string): RunBuffer | undefined {
    return this.runs.get(runId);
  }

  runCount(): number {
    return this.runs.size;
  }
}

function isTerminalEvent(event: WebtoolEvent): boolean {
  if (isLegacyPartEvent(event) && event.type === 'turn.completed') return true;
  if (!event || typeof event !== 'object' || !('type' in event)) return false;
  const t = (event as { type: string }).type;
  return t === 'finish' || t === 'abort' || t === 'error';
}

export const generationStream: GenerationStreamRegistry =
  global.__generationStream ?? new GenerationStreamRegistry();
if (!global.__generationStream) global.__generationStream = generationStream;

/** 启动已结束缓冲清理（幂等）；不参与 turn 超时或终止。 */
export function ensureGenerationStreamRetentionTimer(): void {
  if (global.__generationStreamRetentionTimer) return;
  const interval = Math.max(30_000, Math.min(GEN_RETENTION_MS, 60_000));
  global.__generationStreamRetentionTimer = setInterval(() => {
    generationStream.sweepRetention();
  }, interval);
  // 不阻止进程退出
  if (typeof global.__generationStreamRetentionTimer === 'object' && 'unref' in global.__generationStreamRetentionTimer) {
    (global.__generationStreamRetentionTimer as NodeJS.Timeout).unref?.();
  }
}

// 模块加载时启动已结束缓冲清理（Node 服务端）
if (typeof setInterval !== 'undefined') {
  ensureGenerationStreamRetentionTimer();
}
