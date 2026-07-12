// webtool 消息协议事件 —— M-006：内容帧 = AI SDK UIMessageChunk
//
// 权威契约：project-kb/decisions/uimessagechunk-*.md、generation-stream-resume.md
// runId 由中心在 turn send 路径分配并下发；执行端上行信封必须带回，禁止 client 自 mint。
// 旧 part.* / turn.completed 仅过渡映射，禁止新逻辑加深其语义。

import type { UIMessageChunk as AiUIMessageChunk, UIMessagePart } from 'ai';

// ---------------------------------------------------------------------------
// 内容帧：AI SDK UIMessageChunk（单一内容协议）
// ---------------------------------------------------------------------------

/** 内容帧：对齐 AI SDK `UIMessageChunk`（白名单见 project-kb） */
export type UIMessageChunk = AiUIMessageChunk;

/**
 * 生成流信封（上行 session.event / 中心→浏览器 SSE 内容载荷）。
 * - runId：中心分配，上行必填
 * - seq：仅中心赋值；执行端上行不填或忽略
 * - clientMessageId：预留 user POST 幂等，本期不实现
 */
export type StreamContentEnvelope = {
  /** 中心分配的 turn 级 id；执行端必须带回，禁止自造 */
  runId: string;
  /** 中心单调序号；仅中心赋值 */
  seq?: number;
  chunk: UIMessageChunk;
  /** 预留：user POST 幂等键，本期可不实现 */
  clientMessageId?: string;
};

// ---------------------------------------------------------------------------
// 消息元数据 / HITL（控制面旁路，非 chunk）
// ---------------------------------------------------------------------------

/** 消息级元数据（落库 metadata JSON） */
export interface WebtoolMessageMetadata {
  modelId?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
  cost?: number;
  finishReason?: 'stop' | 'interrupted' | 'error' | 'length' | 'tool-calls' | string;
  /** 乐观 user 消息标记（send 插入，assistant 开始后清除） */
  optimistic?: boolean;
  /** 消息创建时间 ISO（历史加载自 DB createdAt 注入） */
  createdAt?: string;
}

/** 落库 part：UIMessagePart + 私有 _pid（persist 注入） */
export type PersistedPart = UIMessagePart<any, any> & { _pid?: string };

/** HITL 决策：对齐 codex approval — 显式枚举 */
export type HitlDecision = 'allow' | 'deny' | 'cancel';

/** HITL 回答：requestId 必填；控制面 session.respondInput 载荷 */
export type InputResponse = {
  requestId: string;
  /** 显式决策；缺省时若有答案字段则视为 allow */
  decision?: HitlDecision;
  optionId?: string;
  text?: string;
  answers?: Array<{ questionId?: string; optionId?: string; text?: string }>;
};

// ---------------------------------------------------------------------------
// 过渡：旧 part.* / turn.completed（deprecated，禁止加深）
// ---------------------------------------------------------------------------

/**
 * @deprecated 过渡期兼容；目标协议为 UIMessageChunk。禁止新逻辑加深 part.* 语义。
 */
export type LegacyPartEvent =
  | { type: 'part.start'; partId: string; part: UIMessagePart<any, any> }
  | { type: 'part.delta'; partId: string; field: 'text' | 'reasoning' | 'input'; delta: string }
  | { type: 'part.update'; partId: string; patch: Record<string, unknown> }
  | { type: 'part.end'; partId: string; part?: UIMessagePart<any, any> }
  | { type: 'message.metadata'; metadata: Partial<WebtoolMessageMetadata> }
  | {
      type: 'turn.completed';
      finishReason: 'stop' | 'interrupted' | 'error';
      error?: { code: string; message: string };
    };

/** 会话级生命周期（非内容 chunk，控制面旁路） */
export type SessionLifecycleEvent =
  | { type: 'session.connected' }
  | {
      type: 'session.disconnected';
      reason:
        | 'device_offline'
        | 'network'
        | 'restart'
        | 'resume_failed'
        | 'ws_error'
        | 'heartbeat_timeout'
        | 'adapter_error'
        | 'getDb_failed'
        | 'close';
      message?: string;
    }
  | {
      type: 'session.start';
      sessionId: string;
      backend: string;
      model: string;
      history: Array<{ role: string; content: string }>;
    };

/**
 * 总线/前端兼容联合：新内容 = UIMessageChunk；过渡 = LegacyPartEvent；会话 = SessionLifecycleEvent。
 * 新上行优先走 StreamContentEnvelope（见 ws-messages session.event）。
 */
export type WebtoolEvent = UIMessageChunk | LegacyPartEvent | SessionLifecycleEvent;

// ---------------------------------------------------------------------------
// 类型守卫与过渡映射
// ---------------------------------------------------------------------------

/** 是否为生成流信封（含 runId + chunk） */
export function isStreamContentEnvelope(v: unknown): v is StreamContentEnvelope {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.runId === 'string' && o.chunk != null && typeof o.chunk === 'object';
}

/** 是否为已废弃的 part.* / turn.completed / message.metadata */
export function isLegacyPartEvent(v: unknown): v is LegacyPartEvent {
  if (!v || typeof v !== 'object') return false;
  const t = (v as { type?: string }).type;
  return (
    t === 'part.start' ||
    t === 'part.delta' ||
    t === 'part.update' ||
    t === 'part.end' ||
    t === 'message.metadata' ||
    t === 'turn.completed'
  );
}

/**
 * 过渡映射：turn.completed → UIMessageChunk finish/abort/error。
 * @deprecated 适配器应直接发 finish/abort/error
 */
export function mapTurnCompletedToChunk(
  event: Extract<LegacyPartEvent, { type: 'turn.completed' }>,
): UIMessageChunk {
  if (event.finishReason === 'interrupted') {
    return { type: 'abort', reason: event.error?.message };
  }
  if (event.finishReason === 'error') {
    return {
      type: 'error',
      errorText: event.error
        ? `${event.error.code}: ${event.error.message}`
        : 'unknown error',
    };
  }
  // stop → finish
  return {
    type: 'finish',
    finishReason: 'stop',
    messageMetadata: event.error
      ? undefined
      : ({ finishReason: 'stop' } satisfies Partial<WebtoolMessageMetadata>),
  };
}

/**
 * 从 session.event 载荷归一出「扁平」WebtoolEvent（过渡期 gateway/bus 用）。
 * 信封 → chunk；legacy 原样；已是 chunk 原样。
 */
export function normalizeSessionEventPayload(
  payload: StreamContentEnvelope | WebtoolEvent,
): WebtoolEvent {
  if (isStreamContentEnvelope(payload)) {
    return payload.chunk;
  }
  return payload;
}
