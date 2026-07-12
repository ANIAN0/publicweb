// SSE→UIMessage 累积 hook：消费 UIMessageChunk（+ 过渡 part.*）
// 双通道：GET 权威 messages + SSE 展示续接（afterSeq/runId）；刷新禁止隐式 stop
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { UIMessage } from 'ai';
import type {
  WebtoolEvent,
  WebtoolMessageMetadata,
  PersistedPart,
  InputResponse,
  UIMessageChunk,
} from '@/lib/protocol/events';
import { isLegacyPartEvent } from '@/lib/protocol/events';

// 前端消息:UIMessage + metadata + parts(含 _pid,ai-elements 渲染忽略未知字段)
export type FrontendMessage = UIMessage & {
  metadata?: WebtoolMessageMetadata;
  parts: PersistedPart[];
};

// 按 _pid 找 part 下标;找不到返回 -1(与 persist.findPartIndex 一致)
function findPartIndex(parts: PersistedPart[], partId: string): number {
  return parts.findIndex((p) => (p as { _pid?: string })._pid === partId);
}

// 取当前 turn 的 assistant 消息:倒序找最后一条 role=assistant 且 metadata.finishReason 未定。
// 不存在则新建一条空 parts 的 assistant 消息(turn 边界:turn.completed 落 finishReason 后,下个 part.start 自动开新消息)。
// 镜像 persist.getOrCreateCurrentAssistant
function getOrCreateCurrentAssistant(
  messages: FrontendMessage[]
): { messages: FrontendMessage[]; current: FrontendMessage } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.metadata?.finishReason === undefined) {
      return { messages, current: m };
    }
  }
  // 新建 assistant 消息(id 唯一,避免多轮 React key 重复)
  const newMsg: FrontendMessage = {
    id: `asst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    parts: [],
    metadata: {},
  };
  return { messages: [...messages, newMsg], current: newMsg };
}

// 清除最后一条 optimistic user 消息的乐观标记(保留消息内容,assistant part.start 触发)
// HOOK-006：倒序跳过 trailing assistant，只清最近一条 optimistic user；无则原样返回（无冗余 break 歧义）
function clearLastOptimistic(messages: FrontendMessage[]): FrontendMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // 跳过末尾 assistant（turn 进行中）
    if (m.role === 'assistant') continue;
    if (m.role === 'user' && m.metadata?.optimistic) {
      return messages.map((mm, idx) =>
        idx === i ? { ...mm, metadata: { ...mm.metadata, optimistic: false } } : mm,
      );
    }
    // 已碰到非 optimistic 的 user/system → 无需再往前清
    return messages;
  }
  return messages;
}

function findToolPartIndex(parts: PersistedPart[], toolCallId: string): number {
  return parts.findIndex((p) => {
    const pp = p as { _pid?: string; toolCallId?: string };
    return pp._pid === toolCallId || pp.toolCallId === toolCallId;
  });
}

function upsertPart(
  messages: FrontendMessage[],
  partId: string,
  patch: Record<string, unknown>,
  createIfMissing: boolean,
): FrontendMessage[] {
  const cleared = clearLastOptimistic(messages);
  const { messages: m1, current } = getOrCreateCurrentAssistant(cleared);
  const parts = current.parts.slice();
  let idx = findPartIndex(parts, partId);
  if (idx < 0) idx = findToolPartIndex(parts, partId);
  if (idx < 0) {
    if (!createIfMissing) return messages;
    parts.push({ ...patch, _pid: partId } as PersistedPart);
  } else {
    parts[idx] = { ...parts[idx], ...patch, _pid: partId } as PersistedPart;
  }
  return m1.map((m) => (m === current ? { ...m, parts } : m));
}

/** 终态：仅更新 open assistant，无 open 不建空行 */
function applyTerminal(
  messages: FrontendMessage[],
  finishReason: string,
): FrontendMessage[] {
  let open: FrontendMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.metadata?.finishReason === undefined) {
      open = m;
      break;
    }
  }
  if (!open) return messages;
  const parts = open.parts.map((p) => {
    const pp = p as { state?: string };
    if (pp.state === 'streaming' || pp.state === 'input-streaming') {
      return {
        ...p,
        state: pp.state === 'input-streaming' ? 'input-available' : 'done',
      } as PersistedPart;
    }
    return p;
  });
  const metadata: WebtoolMessageMetadata = { ...open.metadata, finishReason };
  return messages.map((m) => (m === open ? { ...m, parts, metadata } : m));
}

/** UIMessageChunk → 前端 messages（展示层；权威仍以 GET 库为准） */
function applyChunk(messages: FrontendMessage[], chunk: UIMessageChunk): FrontendMessage[] {
  switch (chunk.type) {
    case 'start': {
      const cleared = clearLastOptimistic(messages);
      const { messages: m1, current } = getOrCreateCurrentAssistant(cleared);
      if (chunk.messageId && current.id.startsWith('asst-')) {
        // 尽量采用服务端 messageId
        return m1.map((m) =>
          m === current ? { ...m, id: chunk.messageId as string } : m,
        );
      }
      return m1;
    }
    case 'text-start':
      return upsertPart(messages, chunk.id, { type: 'text', text: '', state: 'streaming' }, true);
    case 'text-delta': {
      const { messages: m1, current } = getOrCreateCurrentAssistant(messages);
      const idx = findPartIndex(current.parts, chunk.id);
      if (idx < 0) {
        return upsertPart(
          messages,
          chunk.id,
          { type: 'text', text: chunk.delta, state: 'streaming' },
          true,
        );
      }
      const parts = current.parts.slice();
      const p = { ...parts[idx] } as { text?: string };
      p.text = (p.text ?? '') + chunk.delta;
      parts[idx] = { ...parts[idx], ...p, state: 'streaming' } as PersistedPart;
      return m1.map((m) => (m === current ? { ...m, parts } : m));
    }
    case 'text-end':
      return upsertPart(messages, chunk.id, { type: 'text', state: 'done' }, true);
    case 'reasoning-start':
      return upsertPart(
        messages,
        chunk.id,
        { type: 'reasoning', text: '', state: 'streaming' },
        true,
      );
    case 'reasoning-delta': {
      const { messages: m1, current } = getOrCreateCurrentAssistant(messages);
      const idx = findPartIndex(current.parts, chunk.id);
      if (idx < 0) {
        return upsertPart(
          messages,
          chunk.id,
          { type: 'reasoning', text: chunk.delta, state: 'streaming' },
          true,
        );
      }
      const parts = current.parts.slice();
      const p = { ...parts[idx] } as { text?: string };
      p.text = (p.text ?? '') + chunk.delta;
      parts[idx] = { ...parts[idx], ...p, state: 'streaming' } as PersistedPart;
      return m1.map((m) => (m === current ? { ...m, parts } : m));
    }
    case 'reasoning-end':
      return upsertPart(messages, chunk.id, { type: 'reasoning', state: 'done' }, true);
    case 'tool-input-start':
      return upsertPart(
        messages,
        chunk.toolCallId,
        {
          type: 'dynamic-tool',
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          state: 'input-streaming',
          input: '',
        },
        true,
      );
    case 'tool-input-delta': {
      const { messages: m1, current } = getOrCreateCurrentAssistant(messages);
      const idx = findToolPartIndex(current.parts, chunk.toolCallId);
      if (idx < 0) return messages;
      const parts = current.parts.slice();
      const p = { ...parts[idx] } as { input?: unknown };
      const cur = p.input;
      p.input = (typeof cur === 'string' ? cur : '') + chunk.inputTextDelta;
      parts[idx] = { ...parts[idx], ...p } as PersistedPart;
      return m1.map((m) => (m === current ? { ...m, parts } : m));
    }
    case 'tool-input-available':
      return upsertPart(
        messages,
        chunk.toolCallId,
        {
          type: 'dynamic-tool',
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          state: 'input-available',
          input: chunk.input,
        },
        true,
      );
    case 'tool-input-error':
      return upsertPart(
        messages,
        chunk.toolCallId,
        {
          type: 'dynamic-tool',
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          state: 'output-error',
          input: chunk.input,
          errorText: chunk.errorText,
        },
        true,
      );
    case 'tool-approval-request':
      return upsertPart(
        messages,
        chunk.toolCallId,
        {
          state: 'approval-requested',
          approval: { id: chunk.approvalId },
        },
        true,
      );
    case 'tool-approval-response': {
      // 按 approvalId 定位 part（chunk 无 toolCallId）
      let openIdx = -1;
      let openMsg: FrontendMessage | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'assistant' || m.metadata?.finishReason !== undefined) continue;
        openMsg = m;
        openIdx = m.parts.findIndex(
          (p) => (p as { approval?: { id?: string } }).approval?.id === chunk.approvalId,
        );
        if (openIdx >= 0) break;
      }
      if (!openMsg || openIdx < 0) return messages;
      const parts = openMsg.parts.slice();
      const prev = parts[openIdx] as PersistedPart & { approval?: Record<string, unknown> };
      parts[openIdx] = {
        ...prev,
        state: chunk.approved ? 'approval-responded' : 'output-denied',
        approval: {
          ...prev.approval,
          id: chunk.approvalId,
          approved: chunk.approved,
          reason: chunk.reason,
        },
      } as PersistedPart;
      return messages.map((m) => (m === openMsg ? { ...m, parts } : m));
    }
    case 'tool-output-available':
      if (chunk.preliminary === true) {
        return upsertPart(
          messages,
          chunk.toolCallId,
          { output: chunk.output, state: 'output-available', preliminary: true },
          true,
        );
      }
      return upsertPart(
        messages,
        chunk.toolCallId,
        { output: chunk.output, state: 'output-available', preliminary: false },
        true,
      );
    case 'tool-output-error':
      return upsertPart(
        messages,
        chunk.toolCallId,
        { errorText: chunk.errorText, state: 'output-error' },
        true,
      );
    case 'tool-output-denied':
      return upsertPart(messages, chunk.toolCallId, { state: 'output-denied' }, true);
    case 'message-metadata': {
      const { messages: m1, current } = getOrCreateCurrentAssistant(messages);
      const meta =
        chunk.messageMetadata && typeof chunk.messageMetadata === 'object'
          ? (chunk.messageMetadata as WebtoolMessageMetadata)
          : {};
      return m1.map((m) =>
        m === current ? { ...m, metadata: { ...m.metadata, ...meta } } : m,
      );
    }
    case 'finish':
      return applyTerminal(
        messages,
        (chunk as { finishReason?: string }).finishReason ?? 'stop',
      );
    case 'abort':
      return applyTerminal(messages, 'interrupted');
    case 'error':
      return applyTerminal(messages, 'error');
    default:
      return messages;
  }
}

// 把一条 WebtoolEvent 应用到 messages（chunk 优先；legacy part.* 过渡）
function applyEvent(messages: FrontendMessage[], event: WebtoolEvent): FrontendMessage[] {
  if (isLegacyPartEvent(event)) {
    switch (event.type) {
      case 'part.start': {
        const cleared = clearLastOptimistic(messages);
        const { messages: m1, current } = getOrCreateCurrentAssistant(cleared);
        const part: PersistedPart = { ...event.part, _pid: event.partId } as PersistedPart;
        return m1.map((m) => (m === current ? { ...m, parts: [...m.parts, part] } : m));
      }
      case 'part.delta': {
        const { messages: m1, current } = getOrCreateCurrentAssistant(messages);
        const idx = findPartIndex(current.parts, event.partId);
        if (idx < 0) return messages;
        const parts = current.parts.slice();
        const p = { ...parts[idx] } as Record<string, unknown>;
        if (event.field === 'text' || event.field === 'reasoning') {
          p.text = ((p.text as string) ?? '') + event.delta;
        } else if (event.field === 'input') {
          const cur = p.input;
          p.input = (typeof cur === 'string' ? cur : '') + event.delta;
        }
        parts[idx] = p as PersistedPart;
        return m1.map((m) => (m === current ? { ...m, parts } : m));
      }
      case 'part.update': {
        const { messages: m1, current } = getOrCreateCurrentAssistant(messages);
        const idx = findPartIndex(current.parts, event.partId);
        if (idx < 0) return messages;
        const parts = current.parts.slice();
        parts[idx] = { ...parts[idx], ...event.patch } as PersistedPart;
        return m1.map((m) => (m === current ? { ...m, parts } : m));
      }
      case 'part.end': {
        const { messages: m1, current } = getOrCreateCurrentAssistant(messages);
        const idx = findPartIndex(current.parts, event.partId);
        if (idx < 0) return messages;
        const parts = current.parts.slice();
        parts[idx] = event.part
          ? ({ ...event.part, _pid: event.partId } as PersistedPart)
          : parts[idx];
        return m1.map((m) => (m === current ? { ...m, parts } : m));
      }
      case 'message.metadata': {
        const { messages: m1, current } = getOrCreateCurrentAssistant(messages);
        const metadata: WebtoolMessageMetadata = { ...current.metadata, ...event.metadata };
        return m1.map((m) => (m === current ? { ...m, metadata } : m));
      }
      case 'turn.completed':
        return applyTerminal(messages, event.finishReason);
    }
  }
  // UIMessageChunk
  if (event && typeof event === 'object' && 'type' in event) {
    return applyChunk(messages, event as UIMessageChunk);
  }
  return messages;
}

export interface UseSessionMessagesResult {
  messages: FrontendMessage[];
  sending: boolean;
  resuming: boolean;
  sendError: string | null;
  disconnected: boolean;
  disconnectReason?: string;
  // 返回 true 表示 HTTP 已接受；false 时调用方应恢复 input 草稿（HOOK-004）
  send: (
    content: string,
    opts?: {
      attachments?: Array<{ id: string; filename: string; mediaType: string; size?: number; url?: string }>;
      model?: string;
    },
  ) => Promise<boolean>;
  stop: () => Promise<void>;
  retry: () => Promise<void>;
  dismissDisconnected: () => void;
  // 回答 HITL ask_question / tool-approval(eve input.requested):乐观更新 part + POST /input
  respondInput: (responses: InputResponse[]) => Promise<void>;
  /** 编辑/重发/再生成：截断后续消息并重跑 turn */
  editResend: (opts: {
    messageId: string;
    mode: 'edit' | 'resend' | 'regenerate';
    content?: string;
    model?: string;
  }) => Promise<boolean>;
  /** 从某条消息 fork 新会话；成功返回新 sessionId */
  forkFrom: (fromMessageId: string) => Promise<string | null>;
}

export function useSessionMessages(sessionId: string): UseSessionMessagesResult {
  const [messages, setMessages] = useState<FrontendMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [disconnectReason, setDisconnectReason] = useState<string | undefined>();
  // session event cursor comes from the authority snapshot and remains the
  // only value used by EventSource Last-Event-ID.
  const lastEventIdRef = useRef<number | null>(null);
  const currentRunIdRef = useRef<string | null>(null);
  const completedRunIdsRef = useRef<Set<string>>(new Set());
  // 恢复中反馈:reload 后 open turn 恢复 sending 时置 true,收到首个 turn 事件后置 false
  const [resuming, setResuming] = useState(false);
  // 标记本轮 useEffect 是否已收到 turn 事件(防 fetch 与 EventSource 竞态:fetch 后 setResuming(true) 若已收到事件则跳过)
  const receivedEventRef = useRef(false);
  // send 失败/超时反馈(T-012):用户可见提示,非仅 console.warn
  const [sendError, setSendError] = useState<string | null>(null);
  // HTTP 成功后仍依赖 SSE turn.completed；超时则解锁 sending（与 Local stall 对齐量级）
  const turnTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 「恢复中」横幅超时：Local 无 resume 追事件时避免永久转圈
  const resumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** turn 完成超时（HTTP 已返回后） */
  const TURN_TIMEOUT_MS = 180_000;
  /** reload 后续接等待首个 turn 事件的上限；超时解除 resuming/sending */
  const RESUME_WAIT_MS = 20_000;

  // 清 resume 等待定时器
  const clearResumeTimeout = useCallback(() => {
    if (resumeTimeoutRef.current) {
      clearTimeout(resumeTimeoutRef.current);
      resumeTimeoutRef.current = null;
    }
  }, []);

  // 进入「恢复中」并启动超时兜底（Local 事件丢失 / 无 resume 时不永久转圈）
  const beginResuming = useCallback(() => {
    setSending(true);
    setResuming(true);
    clearResumeTimeout();
    resumeTimeoutRef.current = setTimeout(() => {
      resumeTimeoutRef.current = null;
      // 超时仍无 turn 事件：解锁 UI，提示用户可重试
      setResuming(false);
      setSending(false);
      setSendError('会话恢复超时：未收到模型事件。请重新发送，或新建会话。');
    }, RESUME_WAIT_MS);
  }, [clearResumeTimeout]);

  // 加载历史 + 订阅 SSE
  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    lastEventIdRef.current = null;
    currentRunIdRef.current = null;
    completedRunIdsRef.current.clear();
    receivedEventRef.current = false;  // 新 useEffect 重置(remount/retry 重新等首个事件)
    // 加载历史:db rows(parts/metadata JSON 字符串)→ UIMessage[]
    fetch(`/api/sessions/${sessionId}/messages`)
      .then((res) => {
        if (!res.ok) throw new Error(`load messages failed: ${res.status}`);
        return res.json();
      })
      .then(
        (data: {
          messages: Array<{
            id: string;
            role: string;
            parts: string;
            metadata: string | null;
            createdAt?: string | number | Date;
          }>;
          pendingUserMessage: string | null;
          eventCursor: number;
        }) => {
          if (cancelled) return;
          // T-005 GET 返回 {messages, pendingUserMessage};适配新结构(原数组解析会 break)
          const rows = data.messages;
          const pendingUserMessage = data.pendingUserMessage;
          lastEventIdRef.current = Number.isFinite(data.eventCursor)
            ? data.eventCursor
            : null;
          // 安全解析 JSON 列;空/损坏按空兜底,避免渲染崩溃
          const msgs: FrontendMessage[] = rows.map((r) => {
            let parts: PersistedPart[] = [];
            let metadata: WebtoolMessageMetadata = {};
            try {
              const v = JSON.parse(r.parts);
              parts = Array.isArray(v) ? v : [];
            } catch {
              parts = [];
            }
            if (r.metadata) {
              try {
                metadata = JSON.parse(r.metadata) ?? {};
              } catch {
                metadata = {};
              }
            }
            // 把 DB createdAt 挂到 metadata 供消息 hover 相对时间展示（清单 10.7 / DEEIX）
            // 不覆盖既有 metadata 字段；仅当 row 有 createdAt 时写入
            if (r.createdAt != null) {
              const iso =
                typeof r.createdAt === 'string'
                  ? r.createdAt
                  : new Date(r.createdAt).toISOString();
              metadata = { ...metadata, createdAt: iso };
            }
            return {
              id: r.id,
              role: r.role as UIMessage['role'],
              parts,
              metadata,
            };
          });
          setMessages(msgs);
          // reload 续接:open turn(最后 assistant finishReason 未定)或有未过期 pendingUserMessage → 恢复 sending + 显示"恢复中"
          // 后端 resume(T-006)会追回遗漏事件推 SSE,turn.completed 到达后自然解开 sending
          let lastAssistant: FrontendMessage | undefined;
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant') {
              lastAssistant = msgs[i];
              break;
            }
          }
          const openTurn = lastAssistant !== undefined && lastAssistant.metadata?.finishReason === undefined;
          // 已收到事件(EventSource 先于 fetch 完成)则不置 resuming,避免竞态卡在"恢复中"
          if ((openTurn || pendingUserMessage !== null) && !receivedEventRef.current) {
            beginResuming();
          }
        }
      )
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('load session messages failed:', err);
        setSendError('加载历史消息失败');
      })
      .finally(() => {
        if (!cancelled) startEventSource();
      });

    // 历史加载完成后再订阅 SSE，禁止 GET setMessages 覆盖先到的实时事件。
    function startEventSource() {
      if (cancelled || es) return;
      const qs = new URLSearchParams();
      if (lastEventIdRef.current !== null) {
        qs.set('since', String(lastEventIdRef.current));
      }
      const q = qs.toString();
      const eventUrl = `/api/sessions/${sessionId}/events${q ? `?${q}` : ''}`;
      es = new EventSource(eventUrl);
      es.onmessage = (ev) => {
        if (cancelled) return;
      const lidStr = ev.lastEventId;
      if (lidStr !== '' && /^\d+$/.test(lidStr)) {
        lastEventIdRef.current = Number(lidStr);
      }
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(ev.data);
      } catch {
        return;
      }
      const eventRunId = typeof raw._runId === 'string'
        ? raw._runId
        : typeof raw.runId === 'string'
          ? raw.runId
          : null;
      const event = (
        raw.event && typeof raw.event === 'object' && 'type' in (raw.event as object)
          ? (raw.event as WebtoolEvent)
          : (raw as unknown as WebtoolEvent)
      );
      // 会话级事件单独处理(不进 messages)
      if (event.type === 'session.disconnected') {
        clearResumeTimeout();
        setResuming(false);
        setSending(false);
        setDisconnected(true);
        setDisconnectReason(event.reason);
        return;
      }
      if (event.type === 'session.start') {
        setDisconnected(false);
        setDisconnectReason(undefined);
        return;
      }
      receivedEventRef.current = true;
      clearResumeTimeout();
      setResuming(false);
      // 终态：解开 sending（finish/abort/error 或 legacy turn.completed）
      const isTerminal =
        event.type === 'turn.completed' ||
        event.type === 'finish' ||
        event.type === 'abort' ||
        event.type === 'error';
      if (isTerminal) {
        if (
          eventRunId &&
          currentRunIdRef.current &&
          eventRunId !== currentRunIdRef.current
        ) {
          return;
        }
        if (eventRunId) completedRunIdsRef.current.add(eventRunId);
        if (turnTimeoutRef.current) {
          clearTimeout(turnTimeoutRef.current);
          turnTimeoutRef.current = null;
        }
        if (stopTimeoutRef.current) {
          clearTimeout(stopTimeoutRef.current);
          stopTimeoutRef.current = null;
        }
        setMessages((prev) => applyEvent(prev, event));
        setSending(false);
        currentRunIdRef.current = null;
        if (event.type === 'turn.completed' && event.finishReason === 'error' && event.error?.message) {
          setSendError(event.error.message);
        } else if (event.type === 'error') {
          setSendError((event as { errorText?: string }).errorText ?? 'error');
        }
        return;
      }
      if (eventRunId) currentRunIdRef.current = eventRunId;
      setMessages((prev) => applyEvent(prev, event));
      };
    }

    return () => {
      // 仅关闭 SSE；禁止在 unmount 时调用 stop（C-004 / F-004）
      cancelled = true;
      clearResumeTimeout();
      if (turnTimeoutRef.current) {
        clearTimeout(turnTimeoutRef.current);
        turnTimeoutRef.current = null;
      }
      if (stopTimeoutRef.current) {
        clearTimeout(stopTimeoutRef.current);
        stopTimeoutRef.current = null;
      }
      es?.close();
    };
  }, [sessionId, beginResuming, clearResumeTimeout]);

  const send = useCallback(
    async (
      content: string,
      opts?: {
        attachments?: Array<{ id: string; filename: string; mediaType: string; size?: number; url?: string }>;
        model?: string;
      },
    ): Promise<boolean> => {
      const attachments = opts?.attachments ?? [];
      // 允许纯附件（无文本）
      if ((!content.trim() && attachments.length === 0) || sending) return false;
      setSending(true);
      setSendError(null);  // 清除上次错误(T-012)
      currentRunIdRef.current = null;
      // 乐观插入 user 消息：text + file parts
      const optimisticParts: FrontendMessage['parts'] = [];
      if (content.trim()) {
        optimisticParts.push({ type: 'text', text: content });
      }
      for (const a of attachments) {
        optimisticParts.push({
          type: 'file',
          filename: a.filename,
          mediaType: a.mediaType,
          url: a.url ?? '',
        } as FrontendMessage['parts'][number]);
      }
      if (!content.trim() && attachments.length > 0) {
        optimisticParts.unshift({
          type: 'text',
          text: attachments.map((a) => `[附件] ${a.filename}`).join('\n'),
        });
      }
      const optimisticId = `user-${Date.now()}`;
      const userMsg: FrontendMessage = {
        id: optimisticId,
        role: 'user',
        parts: optimisticParts,
        metadata: { optimistic: true },  // T-013:乐观标记(assistant part.start 清除)
      };
      setMessages((prev) => [...prev, userMsg]);

      // 清除上一轮 turn 超时
      if (turnTimeoutRef.current) {
        clearTimeout(turnTimeoutRef.current);
        turnTimeoutRef.current = null;
      }

      // HTTP request lifetime is independent from the model turn lifetime.
      const requestController = new AbortController();
      const requestTimeout = setTimeout(() => requestController.abort(), 60_000);

      /** HTTP 失败时回滚乐观气泡，避免幽灵消息 */
      const rollbackOptimistic = () => {
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      };

      try {
        const res = await fetch(`/api/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: requestController.signal,
          body: JSON.stringify({
            content,
            ...(attachments.length ? { attachments } : {}),
            ...(opts?.model ? { model: opts.model } : {}),
          }),
        });
        if (!res.ok) {
          setSending(false);
          // T-009/T-010：可读错误（409 并发 / 离线 / 通用）
          let detail = `发送失败:${res.status}`;
          try {
            const body = (await res.json()) as { message?: string; error?: string };
            if (body.message) detail = body.message;
            else if (body.error) detail = `${body.error}${res.status === 409 ? '（请等待当前回复完成）' : ''}`;
          } catch {
            /* ignore */
          }
          if (res.status === 503 || /offline|not connected|device offline/i.test(detail)) {
            detail = `设备离线或不可达：${detail}`;
          }
          setSendError(detail);
          rollbackOptimistic();
          console.warn(`send failed: ${res.status}`, detail);
          return false; // HOOK-004：调用方恢复草稿
        }
        const accepted = await res.json().catch(() => ({})) as { runId?: string };
        if (accepted.runId && completedRunIdsRef.current.delete(accepted.runId)) {
          return true;
        }
        if (accepted.runId) currentRunIdRef.current = accepted.runId;
        // res.ok：user 已入库；等待 SSE turn.completed；超时解锁防永久 sending
        turnTimeoutRef.current = setTimeout(() => {
          turnTimeoutRef.current = null;
          setSending((still) => {
            if (still) {
              setSendError('响应超时：未收到 turn 完成事件，可重试或停止');
              return false;
            }
            return still;
          });
        }, TURN_TIMEOUT_MS);
        return true;
      } catch {
        setSending(false);
        setSendError('发送失败:网络或超时');
        rollbackOptimistic();
        console.warn('send network/timeout error');
        return false; // HOOK-004：调用方恢复草稿
      } finally {
        clearTimeout(requestTimeout);
      }
    },
    [sessionId, sending]
  );

  const stop = useCallback(async () => {
    if (!sending) return;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
      if (!res.ok) {
        setSendError(`停止失败:${res.status}`);
        return;
      }
    } catch (err) {
      console.error('stop failed:', err);
      setSendError('停止失败:网络错误');
      return;
    }
    // Keep waiting for the authoritative terminal; only unlock the UI if the
    // stop endpoint succeeded but that terminal cannot be delivered.
    if (stopTimeoutRef.current) clearTimeout(stopTimeoutRef.current);
    stopTimeoutRef.current = setTimeout(() => {
      stopTimeoutRef.current = null;
      setSending(false);
    }, 2000);
  }, [sessionId, sending]);

  const retry = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/retry`, { method: 'POST' });
      if (res.ok) {
        setDisconnected(false);
        setDisconnectReason(undefined);
      } else {
        console.error('retry failed:', await res.text());
      }
    } catch (err) {
      console.error('retry failed:', err);
    }
  }, [sessionId]);

  // 手动关闭中断横幅(不重连;session.disconnected 事件再次到达会重新打开)
  const dismissDisconnected = useCallback(() => setDisconnected(false), []);

  // 回答 HITL ask_question / tool-approval：对齐 eve client 的 client.input.responded 投影
  // 1) 本地乐观更新：requestId 对应 dynamic-tool → approval-responded + toolMetadata.inputResponse
  // 2) POST /input → adapter.respondInput 独立通道（不经 send，不锁输入框）
  // HOOK-003：失败时 rollback 乐观 state，避免 UI 卡在已回答
  const respondInput = useCallback(
    async (responses: InputResponse[]) => {
      if (responses.length === 0) return;
      const originals = new Map<string, PersistedPart>();
      setMessages((prev) => {
        return prev.map((m) => {
          if (m.role !== 'assistant') return m;
          let changed = false;
          const parts = m.parts.map((p) => {
            const meta = (p as { toolMetadata?: { inputRequest?: { requestId?: string } } }).toolMetadata;
            const req = meta?.inputRequest;
            if (!req) return p;
            const resp = responses.find((r) => r.requestId === req.requestId);
            if (!resp) return p;
            originals.set(req.requestId!, p as PersistedPart);
            changed = true;
            // 浅合并 toolMetadata；cancel/deny 用 output-denied，allow 用 approval-responded
            const existingMeta = (p as { toolMetadata?: Record<string, unknown> }).toolMetadata ?? {};
            const decision = resp.decision ?? 'allow';
            const state =
              decision === 'cancel' || decision === 'deny'
                ? 'output-denied'
                : 'approval-responded';
            return {
              ...p,
              state,
              toolMetadata: {
                ...existingMeta,
                inputResponse: resp,
              },
            } as PersistedPart;
          });
          return changed ? { ...m, parts } : m;
        });
      });
      const rollback = () => {
        setMessages((current) => current.map((m) => {
          let changed = false;
          const parts = m.parts.map((p) => {
            const meta = (p as {
              toolMetadata?: {
                inputRequest?: { requestId?: string };
                inputResponse?: { requestId?: string };
              };
            }).toolMetadata;
            const requestId = meta?.inputRequest?.requestId;
            const original = requestId ? originals.get(requestId) : undefined;
            if (!original || meta?.inputResponse?.requestId !== requestId) return p;
            changed = true;
            return original;
          });
          return changed ? { ...m, parts } : m;
        }));
      };
      try {
        const res = await fetch(`/api/sessions/${sessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputResponses: responses }),
        });
        if (!res.ok) {
          rollback();
          setSendError(`HITL 回答失败:${res.status}`);
          console.error('respondInput failed:', res.status);
        }
      } catch (err) {
        rollback();
        setSendError('HITL 回答失败:网络错误');
        console.error('respondInput failed:', err);
      }
    },
    [sessionId]
  );

  // 编辑/重发/再生成：服务端截断 + restart + send；前端本地截断乐观 UI
  const editResend = useCallback(
    async (opts: {
      messageId: string;
      mode: 'edit' | 'resend' | 'regenerate';
      content?: string;
      model?: string;
    }): Promise<boolean> => {
      if (sending) return false;
      setSending(true);
      setSendError(null);

      let snapshot: FrontendMessage[] | null = null;
      setMessages((prev) => {
        snapshot = prev;
        const idx = prev.findIndex((m) => m.id === opts.messageId);
        if (idx < 0) return prev;
        if (opts.mode === 'regenerate' && prev[idx]?.role === 'assistant') {
          return prev.slice(0, idx);
        }
        let kept = prev.slice(0, idx + 1);
        if (opts.mode === 'edit' && opts.content) {
          kept = kept.map((m, i) =>
            i === kept.length - 1
              ? {
                  ...m,
                  parts: [{ type: 'text' as const, text: opts.content! }],
                }
              : m,
          );
        }
        return kept;
      });
      const rollback = () => {
        if (!snapshot) return;
        const original = snapshot;
        setMessages((current) => {
          const currentById = new Map(current.map((m) => [m.id, m]));
          const restored = original.map((m) =>
            m.id === opts.messageId ? m : currentById.get(m.id) ?? m,
          );
          const originalIds = new Set(original.map((m) => m.id));
          return [
            ...restored,
            ...current.filter((m) => !originalIds.has(m.id)),
          ];
        });
      };

      try {
        const res = await fetch(`/api/sessions/${sessionId}/edit-resend`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({})) as { error?: string };
          rollback();
          setSending(false);
          setSendError(errBody.error ?? `操作失败:${res.status}`);
          return false;
        }
        const accepted = await res.json().catch(() => ({})) as { runId?: string };
        if (accepted.runId && completedRunIdsRef.current.delete(accepted.runId)) {
          return true;
        }
        if (accepted.runId) currentRunIdRef.current = accepted.runId;
        if (turnTimeoutRef.current) clearTimeout(turnTimeoutRef.current);
        turnTimeoutRef.current = setTimeout(() => {
          turnTimeoutRef.current = null;
          setSending(false);
          setSendError('响应超时：未收到 turn 完成事件，可重试或停止');
        }, TURN_TIMEOUT_MS);
        return true;
      } catch {
        rollback();
        setSending(false);
        setSendError('操作失败:网络错误');
        return false;
      }
    },
    [sessionId, sending],
  );

  const forkFrom = useCallback(
    async (fromMessageId: string): Promise<string | null> => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/fork`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fromMessageId }),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({})) as { error?: string };
          setSendError(errBody.error ?? `分支失败:${res.status}`);
          return null;
        }
        const data = await res.json() as { id: string };
        return data.id ?? null;
      } catch {
        setSendError('分支失败:网络错误');
        return null;
      }
    },
    [sessionId],
  );

  return {
    messages,
    sending,
    resuming,
    sendError,
    disconnected,
    disconnectReason,
    send,
    stop,
    retry,
    dismissDisconnected,
    respondInput,
    editResend,
    forkFrom,
  };
}
