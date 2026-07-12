/**
 * 共享消息持久化层 —— C-003 / T-002：白名单分流 + 物化 UIMessage.parts
 *
 * - 内容目标：UIMessageChunk；权威 type 才写 messages
 * - 本 turn 至多一次 assistant INSERT；之后只 UPDATE parts/metadata
 * - 物化状态自持（内存 turn 快照），不读 generation-stream 缓冲
 * - 中断/失败：parts 非空才 partial 落库；空则不建空 assistant
 * - 过渡：仍接受 legacy part.* / turn.completed
 */
import { getDb } from '@/lib/db/client';
import { messages, sessions } from '@/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { ulid } from 'ulid';
import type {
  LegacyPartEvent,
  PersistedPart,
  UIMessageChunk,
  WebtoolEvent,
  WebtoolMessageMetadata,
} from '@/lib/protocol/events';
import { isLegacyPartEvent, isStreamContentEnvelope } from '@/lib/protocol/events';
import { isAuthorityChunk, isTerminalChunk } from '@/lib/protocol/authority-whitelist';
import { withSeqRetry } from '@/lib/db/next-seq';
import { debugLog } from '@/lib/debug-log';
import { parseMessageMetadata } from '@/lib/backends/parse-metadata';
import { settleTurnLock } from '@/lib/backends/turn-lock';

// ---------------------------------------------------------------------------
// 自持 turn 物化快照（禁止从 T-002b 反读）
// ---------------------------------------------------------------------------

type TurnMaterializeState = {
  /** 中心 runId（若已知） */
  runId?: string;
  /** chunk.start 带来的 preferred messageId（INSERT 时使用） */
  preferredMessageId?: string;
  /** 已落库的 open assistant 行 id；未 INSERT 前为空 */
  messageId?: string;
  /** 终态已写入则 true（finish/abort/error/turn.completed 幂等） */
  settled: boolean;
  /** 内存中的 parts 快照（权威写库与 partial interrupt 同源） */
  parts: PersistedPart[];
  metadata: WebtoolMessageMetadata;
  /** text/reasoning 聚合缓冲（id → 文本） */
  textBuf: Map<string, string>;
  reasoningBuf: Map<string, string>;
  /** tool 入参流式缓冲 */
  toolInputBuf: Map<string, string>;
};

/** sessionId → 进行中 turn 物化状态（挂 global，避免 Next HMR 丢 Map 却留总线订阅） */
declare global {
  // eslint-disable-next-line no-var
  var __webtoolTurnMaterializeStates: Map<string, TurnMaterializeState> | undefined;
}

function turnStates(): Map<string, TurnMaterializeState> {
  if (!global.__webtoolTurnMaterializeStates) {
    global.__webtoolTurnMaterializeStates = new Map();
  }
  return global.__webtoolTurnMaterializeStates;
}

function emptyTurnState(): TurnMaterializeState {
  return {
    settled: false,
    parts: [],
    metadata: {},
    textBuf: new Map(),
    reasoningBuf: new Map(),
    toolInputBuf: new Map(),
  };
}

function getTurnState(sessionId: string): TurnMaterializeState {
  const map = turnStates();
  let s = map.get(sessionId);
  if (!s) {
    s = emptyTurnState();
    map.set(sessionId, s);
  }
  return s;
}

/**
 * 重置为新一轮（用户新 send / chunk.start）。
 * 终态后**不**立刻 delete：迟到 text-end 会新建空 state 再 INSERT 第二条 assistant（DEF-001）。
 */
function resetTurnState(sessionId: string): TurnMaterializeState {
  const s = emptyTurnState();
  turnStates().set(sessionId, s);
  return s;
}

/** 清 turn 内存态（显式 release / 新 turn 前） */
export function clearTurnMaterializeState(sessionId: string): void {
  turnStates().delete(sessionId);
}

/** 新 user turn 开始：丢弃已 settled 快照，允许下一轮物化 */
export function beginTurnMaterialize(sessionId: string, runId?: string): void {
  const state = resetTurnState(sessionId);
  state.runId = runId;
}

function parseParts(json: string | null | undefined): PersistedPart[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function findPartIndex(parts: PersistedPart[], partId: string): number {
  return parts.findIndex((p) => (p as { _pid?: string })._pid === partId);
}

function findToolPartIndex(parts: PersistedPart[], toolCallId: string): number {
  return parts.findIndex((p) => {
    const pp = p as { _pid?: string; toolCallId?: string; type?: string };
    return pp._pid === toolCallId || pp.toolCallId === toolCallId;
  });
}

/** 当前 parts 是否有可物化内容（非空） */
function hasMaterializableParts(parts: PersistedPart[]): boolean {
  return parts.length > 0;
}

// ---------------------------------------------------------------------------
// DB：ensure / flush open assistant
// ---------------------------------------------------------------------------

/**
 * 确保 open assistant 行存在并返回 id。
 * 仅在确有可写内容意图时调用（禁止无内容空 INSERT）。
 */
async function ensureOpenAssistant(
  sessionId: string,
  state: TurnMaterializeState,
  preferredId?: string,
): Promise<string> {
  if (state.messageId) return state.messageId;

  const db = await getDb();
  // 已有 open 行则复用（reload 后内存空）
  const [last] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant')))
    .orderBy(desc(messages.seq))
    .limit(1);
  if (last) {
    const meta = parseMessageMetadata(last.metadata);
    if (meta.finishReason === undefined) {
      state.messageId = last.id;
      state.parts = parseParts(last.parts);
      state.metadata = meta;
      return last.id;
    }
  }

  const id = preferredId && preferredId.length > 0 ? preferredId : ulid();
  await withSeqRetry(sessionId, async (nextSeq) => {
    await db.insert(messages).values({
      id,
      sessionId,
      seq: nextSeq,
      role: 'assistant',
      parts: JSON.stringify(state.parts),
      metadata: Object.keys(state.metadata).length
        ? JSON.stringify(state.metadata)
        : null,
      createdAt: new Date(),
    });
    debugLog('persist', `assistant created sid=${sessionId} id=${id} seq=${nextSeq}`);
  });
  state.messageId = id;
  return id;
}

/** 将 state.parts / metadata 刷到 open assistant 行 */
async function flushOpenAssistant(sessionId: string, state: TurnMaterializeState): Promise<void> {
  if (!state.messageId) return;
  const db = await getDb();
  await db
    .update(messages)
    .set({
      parts: JSON.stringify(state.parts),
      metadata:
        Object.keys(state.metadata).length > 0 ? JSON.stringify(state.metadata) : null,
    })
    .where(eq(messages.id, state.messageId));
}

async function clearPending(sessionId: string, runId?: string): Promise<void> {
  const released = await settleTurnLock(sessionId, runId);
  // 兼容迁移前已经处于 pending、但尚无 turn_locks 行的旧会话。
  if (!released && !runId) {
    const db = await getDb();
    await db.update(sessions).set({
      pendingUserMessage: null,
      pendingUserMessageCreatedAt: null,
    }).where(eq(sessions.id, sessionId));
  }
}

// ---------------------------------------------------------------------------
// UIMessageChunk 物化
// ---------------------------------------------------------------------------

function upsertTextPart(state: TurnMaterializeState, id: string, text: string, kind: 'text' | 'reasoning') {
  const idx = findPartIndex(state.parts, id);
  const part: PersistedPart =
    kind === 'text'
      ? ({ type: 'text', text, state: 'done', _pid: id } as PersistedPart)
      : ({ type: 'reasoning', text, state: 'done', _pid: id } as PersistedPart);
  if (idx >= 0) state.parts[idx] = part;
  else state.parts.push(part);
}

function upsertToolPart(
  state: TurnMaterializeState,
  toolCallId: string,
  patch: Record<string, unknown>,
) {
  const idx = findToolPartIndex(state.parts, toolCallId);
  if (idx >= 0) {
    state.parts[idx] = { ...state.parts[idx], ...patch, _pid: toolCallId } as PersistedPart;
  } else {
    state.parts.push({
      type: 'dynamic-tool',
      toolCallId,
      _pid: toolCallId,
      ...patch,
    } as PersistedPart);
  }
}

/**
 * 应用仅流 chunk 到内存缓冲（不写库）。
 * 权威 end 时从缓冲取完整文本。
 */
function applyStreamOnlyToMemory(state: TurnMaterializeState, chunk: UIMessageChunk): void {
  switch (chunk.type) {
    case 'text-start':
      state.textBuf.set(chunk.id, state.textBuf.get(chunk.id) ?? '');
      break;
    case 'text-delta':
      state.textBuf.set(chunk.id, (state.textBuf.get(chunk.id) ?? '') + chunk.delta);
      break;
    case 'reasoning-start':
      state.reasoningBuf.set(chunk.id, state.reasoningBuf.get(chunk.id) ?? '');
      break;
    case 'reasoning-delta':
      state.reasoningBuf.set(
        chunk.id,
        (state.reasoningBuf.get(chunk.id) ?? '') + chunk.delta,
      );
      break;
    case 'tool-input-delta':
      state.toolInputBuf.set(
        chunk.toolCallId,
        (state.toolInputBuf.get(chunk.toolCallId) ?? '') + chunk.inputTextDelta,
      );
      break;
    default:
      break;
  }
}

async function materializeAuthorityChunk(
  sessionId: string,
  state: TurnMaterializeState,
  chunk: UIMessageChunk,
): Promise<void> {
  // 已终态：迟到 chunk 不得新开 assistant（DEF-001 鬼影）
  if (state.settled) {
    if (chunk.type === 'start') {
      // 下一轮 start：重置后再处理
      state = resetTurnState(sessionId);
    } else if (isTerminalChunk(chunk)) {
      await clearPending(sessionId);
      return;
    } else {
      debugLog(
        'persist',
        `drop late chunk after settle sid=${sessionId} type=${chunk.type}`,
      );
      return;
    }
  }

  switch (chunk.type) {
    case 'start': {
      // M-open：只记 preferred messageId；真正 INSERT 延迟到首次有可物化 parts
      if (chunk.messageId) {
        state.preferredMessageId = chunk.messageId;
      }
      if (chunk.messageMetadata && typeof chunk.messageMetadata === 'object') {
        state.metadata = {
          ...state.metadata,
          ...(chunk.messageMetadata as WebtoolMessageMetadata),
        };
      }
      return;
    }

    case 'message-metadata': {
      if (chunk.messageMetadata && typeof chunk.messageMetadata === 'object') {
        state.metadata = {
          ...state.metadata,
          ...(chunk.messageMetadata as WebtoolMessageMetadata),
        };
      }
      // 仅当已有 open 行或已有 parts 才写 metadata（避免空 assistant）
      if (state.messageId || hasMaterializableParts(state.parts)) {
        await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
        await flushOpenAssistant(sessionId, state);
      }
      return;
    }

    case 'text-end': {
      const snapshot = (chunk.providerMetadata as { webtool?: { text?: unknown } } | undefined)
        ?.webtool?.text;
      const text = typeof snapshot === 'string' ? snapshot : (state.textBuf.get(chunk.id) ?? '');
      state.textBuf.delete(chunk.id);
      upsertTextPart(state, chunk.id, text, 'text');
      await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
      await flushOpenAssistant(sessionId, state);
      return;
    }

    case 'reasoning-end': {
      const snapshot = (chunk.providerMetadata as { webtool?: { text?: unknown } } | undefined)
        ?.webtool?.text;
      const text = typeof snapshot === 'string' ? snapshot : (state.reasoningBuf.get(chunk.id) ?? '');
      state.reasoningBuf.delete(chunk.id);
      upsertTextPart(state, chunk.id, text, 'reasoning');
      await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
      await flushOpenAssistant(sessionId, state);
      return;
    }

    case 'tool-input-start': {
      upsertToolPart(state, chunk.toolCallId, {
        type: 'dynamic-tool',
        toolName: chunk.toolName,
        state: 'input-streaming',
        input: state.toolInputBuf.get(chunk.toolCallId) ?? '',
        ...(chunk.title ? { title: chunk.title } : {}),
      });
      await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
      await flushOpenAssistant(sessionId, state);
      return;
    }

    case 'tool-input-available': {
      const buffered = state.toolInputBuf.get(chunk.toolCallId);
      state.toolInputBuf.delete(chunk.toolCallId);
      upsertToolPart(state, chunk.toolCallId, {
        type: 'dynamic-tool',
        toolName: chunk.toolName,
        state: 'input-available',
        input: chunk.input ?? buffered ?? {},
        ...(chunk.title ? { title: chunk.title } : {}),
      });
      await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
      await flushOpenAssistant(sessionId, state);
      return;
    }

    case 'tool-input-error': {
      upsertToolPart(state, chunk.toolCallId, {
        type: 'dynamic-tool',
        toolName: chunk.toolName,
        state: 'output-error',
        input: chunk.input ?? {},
        errorText: chunk.errorText,
      });
      await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
      await flushOpenAssistant(sessionId, state);
      return;
    }

    case 'tool-approval-request': {
      upsertToolPart(state, chunk.toolCallId, {
        type: 'dynamic-tool',
        state: 'approval-requested',
        approval: { id: chunk.approvalId },
      });
      await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
      await flushOpenAssistant(sessionId, state);
      return;
    }

    case 'tool-approval-response': {
      const idx = state.parts.findIndex(
        (p) => (p as { approval?: { id?: string } }).approval?.id === chunk.approvalId,
      );
      if (idx >= 0) {
        const p = state.parts[idx] as PersistedPart & {
          state?: string;
          approval?: Record<string, unknown>;
        };
        state.parts[idx] = {
          ...p,
          state: chunk.approved ? 'approval-responded' : 'output-denied',
          approval: { ...p.approval, approved: chunk.approved, reason: chunk.reason },
        } as PersistedPart;
        if (state.messageId || hasMaterializableParts(state.parts)) {
          await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
          await flushOpenAssistant(sessionId, state);
        }
      }
      return;
    }

    case 'tool-output-available': {
      if (chunk.preliminary === true) return; // 双保险：白名单应已挡
      upsertToolPart(state, chunk.toolCallId, {
        state: 'output-available',
        output: chunk.output,
      });
      await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
      await flushOpenAssistant(sessionId, state);
      return;
    }

    case 'tool-output-error': {
      upsertToolPart(state, chunk.toolCallId, {
        state: 'output-error',
        errorText: chunk.errorText,
      });
      await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
      await flushOpenAssistant(sessionId, state);
      return;
    }

    case 'tool-output-denied': {
      upsertToolPart(state, chunk.toolCallId, {
        state: 'output-denied',
      });
      await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
      await flushOpenAssistant(sessionId, state);
      return;
    }

    case 'source-url': {
      state.parts.push({
        type: 'source-url',
        sourceId: chunk.sourceId,
        url: chunk.url,
        title: chunk.title,
        _pid: chunk.sourceId,
      } as PersistedPart);
      await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
      await flushOpenAssistant(sessionId, state);
      return;
    }

    case 'source-document': {
      state.parts.push({
        type: 'source-document',
        sourceId: chunk.sourceId,
        mediaType: chunk.mediaType,
        title: chunk.title,
        filename: chunk.filename,
        _pid: chunk.sourceId,
      } as PersistedPart);
      await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
      await flushOpenAssistant(sessionId, state);
      return;
    }

    case 'file': {
      state.parts.push({
        type: 'file',
        url: chunk.url,
        mediaType: chunk.mediaType,
        _pid: ulid(),
      } as PersistedPart);
      await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
      await flushOpenAssistant(sessionId, state);
      return;
    }

    case 'reasoning-file': {
      state.parts.push({
        type: 'reasoning-file',
        url: chunk.url,
        mediaType: chunk.mediaType,
        _pid: ulid(),
      } as PersistedPart);
      await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
      await flushOpenAssistant(sessionId, state);
      return;
    }

    case 'finish':
    case 'abort':
    case 'error': {
      await settleTurn(sessionId, state, finishReasonFromChunk(chunk), chunk);
      return;
    }

    default: {
      // data-* 等：整段写入 parts
      if (typeof chunk.type === 'string' && chunk.type.startsWith('data-')) {
        state.parts.push({
          ...chunk,
          _pid: (chunk as { id?: string }).id ?? ulid(),
        } as PersistedPart);
        await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
        await flushOpenAssistant(sessionId, state);
      }
      return;
    }
  }
}

function finishReasonFromChunk(chunk: UIMessageChunk): string {
  if (chunk.type === 'abort') return 'interrupted';
  if (chunk.type === 'error') return 'error';
  if (chunk.type === 'finish') {
    return (chunk as { finishReason?: string }).finishReason ?? 'stop';
  }
  return 'stop';
}

/**
 * 终态：partial 物化（仅非空 parts）+ finishReason + 清 pending + 幂等。
 * 供 finish/abort/error 与外部 idle 调用。
 */
async function settleTurn(
  sessionId: string,
  state: TurnMaterializeState,
  finishReason: string,
  chunk?: UIMessageChunk,
): Promise<void> {
  if (state.settled) {
    await clearPending(sessionId, state.runId);
    return;
  }

  // 把未 end 的 text/reasoning 缓冲并入 parts（中断 partial）
  for (const [id, text] of state.textBuf) {
    if (text) upsertTextPart(state, id, text, 'text');
  }
  state.textBuf.clear();
  for (const [id, text] of state.reasoningBuf) {
    if (text) upsertTextPart(state, id, text, 'reasoning');
  }
  state.reasoningBuf.clear();

  // streaming part → done
  for (const p of state.parts) {
    if ((p as { state?: string }).state === 'streaming') {
      (p as { state?: string }).state = 'done';
    }
    if ((p as { state?: string }).state === 'input-streaming') {
      (p as { state?: string }).state = 'input-available';
    }
  }

  if (chunk?.type === 'error') {
    state.metadata = {
      ...state.metadata,
      finishReason,
      // 错误文本可进 metadata 扩展；不强制 schema
    };
  } else if (chunk?.type === 'finish' && chunk.messageMetadata) {
    state.metadata = {
      ...state.metadata,
      ...(chunk.messageMetadata as WebtoolMessageMetadata),
      finishReason,
    };
  } else {
    state.metadata = { ...state.metadata, finishReason };
  }

  const isInterruptOrError =
    finishReason === 'interrupted' ||
    finishReason === 'error' ||
    chunk?.type === 'abort' ||
    chunk?.type === 'error';

  if (hasMaterializableParts(state.parts)) {
    // 有内容：确保行存在并 flush
    await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
    await flushOpenAssistant(sessionId, state);
  } else if (state.messageId) {
    // 已有空 open 行：只写 finishReason，不删行（历史兼容）
    await flushOpenAssistant(sessionId, state);
  } else if (isInterruptOrError) {
    // DEF-002：用户停止/错误必须可见终态，即使尚无 partial 文本
    // 写入最小 text part，避免「仅清 pending、历史像没发生过」
    const reasonText =
      chunk?.type === 'error'
        ? String((chunk as { errorText?: string }).errorText ?? 'error')
        : chunk?.type === 'abort'
          ? String((chunk as { reason?: string }).reason ?? 'interrupted')
          : finishReason;
    state.parts.push({
      type: 'text',
      text: '',
      state: 'done',
      _pid: `terminal:${finishReason}`,
      // 前端可辨识中断；空 text 仍占一条 assistant 行
      ...(reasonText ? { _terminalReason: reasonText } : {}),
    } as PersistedPart);
    await ensureOpenAssistant(sessionId, state, state.preferredMessageId);
    await flushOpenAssistant(sessionId, state);
  }
  // 正常 finish 且完全无内容：仍不 INSERT 空成功行

  state.settled = true;
  await clearPending(sessionId, state.runId);
  // 保留 settled 快照供幂等；勿 delete（迟到 text-end 会再 INSERT 鬼影）
}

/**
 * 外部（T-006 idle / stop）幂等终态入口。
 * 使用 persist 自持 parts，不从 generation-stream 取。
 */
export async function settleTurnInterrupted(
  sessionId: string,
  finishReason: 'interrupted' | 'error' | 'stop' = 'interrupted',
  error?: { code: string; message: string },
): Promise<void> {
  const state = getTurnState(sessionId);
  if (error) {
    state.metadata = {
      ...state.metadata,
      // 可观测错误
    };
  }
  const synthetic: UIMessageChunk =
    finishReason === 'interrupted'
      ? { type: 'abort', reason: error?.message }
      : finishReason === 'error'
        ? { type: 'error', errorText: error ? `${error.code}: ${error.message}` : 'error' }
        : { type: 'finish', finishReason: 'stop' };
  await settleTurn(sessionId, state, finishReason, synthetic);
}

// ---------------------------------------------------------------------------
// Legacy part.* 路径（过渡，禁止加深）
// ---------------------------------------------------------------------------

async function getOrCreateCurrentAssistantLegacy(
  sessionId: string,
): Promise<{ id: string; parts: PersistedPart[]; metadata: WebtoolMessageMetadata }> {
  const state = getTurnState(sessionId);
  if (state.messageId) {
    return { id: state.messageId, parts: state.parts, metadata: state.metadata };
  }
  const db = await getDb();
  const [last] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant')))
    .orderBy(desc(messages.seq))
    .limit(1);
  if (last) {
    const meta = parseMessageMetadata(last.metadata);
    if (meta.finishReason === undefined) {
      state.messageId = last.id;
      state.parts = parseParts(last.parts);
      state.metadata = meta;
      return { id: last.id, parts: state.parts, metadata: meta };
    }
  }
  // legacy part.start 会创建；与旧行为一致
  return withSeqRetry(sessionId, async (nextSeq) => {
    const id = ulid();
    await db.insert(messages).values({
      id,
      sessionId,
      seq: nextSeq,
      role: 'assistant',
      parts: JSON.stringify([]),
      metadata: null,
      createdAt: new Date(),
    });
    debugLog('persist', `assistant created (legacy) sid=${sessionId} id=${id} seq=${nextSeq}`);
    state.messageId = id;
    state.parts = [];
    state.metadata = {};
    return { id, parts: state.parts, metadata: state.metadata };
  });
}

async function persistLegacyEvent(sessionId: string, event: LegacyPartEvent): Promise<void> {
  const db = await getDb();
  const state = getTurnState(sessionId);

  if (state.settled && event.type === 'turn.completed') {
    await clearPending(sessionId);
    return;
  }

  if (event.type === 'part.start') {
    const cur = await getOrCreateCurrentAssistantLegacy(sessionId);
    if (findPartIndex(cur.parts, event.partId) >= 0) return;
    const part: PersistedPart = { ...event.part, _pid: event.partId } as PersistedPart;
    cur.parts.push(part);
    state.parts = cur.parts;
    await db
      .update(messages)
      .set({ parts: JSON.stringify(cur.parts) })
      .where(eq(messages.id, cur.id));
    return;
  }

  if (event.type === 'part.delta') {
    const cur = await getOrCreateCurrentAssistantLegacy(sessionId);
    const idx = findPartIndex(cur.parts, event.partId);
    if (idx < 0) return;
    const part = cur.parts[idx] as Record<string, unknown>;
    if (event.field === 'text' || event.field === 'reasoning') {
      part.text = ((part.text as string) ?? '') + event.delta;
    } else if (event.field === 'input') {
      const cur2 = part.input;
      part.input = (typeof cur2 === 'string' ? cur2 : '') + event.delta;
    }
    state.parts = cur.parts;
    await db
      .update(messages)
      .set({ parts: JSON.stringify(cur.parts) })
      .where(eq(messages.id, cur.id));
    return;
  }

  if (event.type === 'part.update') {
    const cur = await getOrCreateCurrentAssistantLegacy(sessionId);
    const idx = findPartIndex(cur.parts, event.partId);
    if (idx < 0) return;
    cur.parts[idx] = { ...cur.parts[idx], ...event.patch } as PersistedPart;
    state.parts = cur.parts;
    await db
      .update(messages)
      .set({ parts: JSON.stringify(cur.parts) })
      .where(eq(messages.id, cur.id));
    return;
  }

  if (event.type === 'part.end') {
    const cur = await getOrCreateCurrentAssistantLegacy(sessionId);
    const idx = findPartIndex(cur.parts, event.partId);
    if (idx < 0) return;
    if (event.part) {
      cur.parts[idx] = { ...event.part, _pid: event.partId } as PersistedPart;
    }
    state.parts = cur.parts;
    await db
      .update(messages)
      .set({ parts: JSON.stringify(cur.parts) })
      .where(eq(messages.id, cur.id));
    return;
  }

  if (event.type === 'message.metadata') {
    const cur = await getOrCreateCurrentAssistantLegacy(sessionId);
    const merged: WebtoolMessageMetadata = { ...cur.metadata, ...event.metadata };
    state.metadata = merged;
    await db
      .update(messages)
      .set({ metadata: JSON.stringify(merged) })
      .where(eq(messages.id, cur.id));
    return;
  }

  if (event.type === 'turn.completed') {
    // 与 chunk 路径共用 settle 语义（含 interrupt 空行）
    await settleTurn(sessionId, state, event.finishReason, {
      type:
        event.finishReason === 'interrupted'
          ? 'abort'
          : event.finishReason === 'error'
            ? 'error'
            : 'finish',
      finishReason: event.finishReason,
      ...(event.finishReason === 'error' ? { errorText: 'turn.completed error' } : {}),
      ...(event.finishReason === 'interrupted' ? { reason: 'turn.completed' } : {}),
    } as UIMessageChunk);
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function isUIMessageChunk(event: WebtoolEvent): event is UIMessageChunk {
  if (!event || typeof event !== 'object' || !('type' in event)) return false;
  if (isLegacyPartEvent(event)) return false;
  const t = (event as { type: string }).type;
  // session.* 生命周期
  if (t === 'session.connected' || t === 'session.disconnected' || t === 'session.start') {
    return false;
  }
  // 有 type 且非 legacy → 当作 chunk（含未知 type）
  return typeof t === 'string';
}

/**
 * 把一条 WebtoolEvent / UIMessageChunk 写入权威库（按白名单）。
 * 仅流 type 只更新内存缓冲，不写 messages。
 */
async function persistSessionEventUnlocked(
  sessionId: string,
  event: WebtoolEvent,
  runId?: string,
): Promise<void> {
  try {
    // 防御：若误传信封，先绑 runId 再剥开 chunk
    if (isStreamContentEnvelope(event)) {
      const state = getTurnState(sessionId);
      state.runId = event.runId;
      await persistSessionEventUnlocked(sessionId, event.chunk, event.runId);
      return;
    }

    if (isLegacyPartEvent(event)) {
      await persistLegacyEvent(sessionId, event);
      return;
    }

    if (!isUIMessageChunk(event)) {
      // session.connected 等
      return;
    }

    const state = getTurnState(sessionId);
    if (runId) state.runId = runId;

    // 仅流：只更新内存缓冲，不写 messages
    if (!isAuthorityChunk(event)) {
      applyStreamOnlyToMemory(state, event);
      return;
    }

    // 权威：物化（text-end 等依赖此前 delta 缓冲）
    await materializeAuthorityChunk(sessionId, state, event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const type =
      event && typeof event === 'object' && 'type' in event
        ? String((event as { type: unknown }).type)
        : 'unknown';
    debugLog('persist', `failed sid=${sessionId} event=${type} err=${msg}`);
    console.error(`[persist] failed sessionId=${sessionId} event=${type}:`, err);
    throw err;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __authorityPersistChains: Map<string, Promise<unknown>> | undefined;
}

function authorityPersistChains(): Map<string, Promise<unknown>> {
  if (!global.__authorityPersistChains) global.__authorityPersistChains = new Map();
  return global.__authorityPersistChains;
}

function enqueueAuthorityTask<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const chains = authorityPersistChains();
  const previous = chains.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  chains.set(sessionId, current);
  const cleanup = () => {
    if (chains.get(sessionId) === current) chains.delete(sessionId);
  };
  void current.then(cleanup, cleanup);
  return current;
}

/** Serialize authority materialization per session. */
export function persistSessionEvent(
  sessionId: string,
  event: WebtoolEvent,
  runId?: string,
): Promise<void> {
  return enqueueAuthorityTask(sessionId, () =>
    persistSessionEventUnlocked(sessionId, event, runId),
  );
}

/**
 * Run a database snapshot after every event already published for this session.
 * Events published afterwards enqueue behind the snapshot, so the returned
 * event cursor is an exact boundary for SSE replay.
 */
export function withAuthoritySnapshot<T>(
  sessionId: string,
  reader: () => Promise<T>,
): Promise<T> {
  return enqueueAuthorityTask(sessionId, reader);
}

// LIB-024：实现迁至 lib/chat/parts；此处 re-export 保持旧 import 兼容
export { extractTextFromParts } from '@/lib/chat/parts';
