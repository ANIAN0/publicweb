// SSE→UIMessage 累积 hook:把 webtool 的 part.* 流式事件累积成 UIMessage[]
// 前端镜像 persist.ts 的 _pid 定位 + 增量累积逻辑(见 03-protocol-contract.md / 06-backend-id-system.md)
// 替代 page.tsx 旧版(text.delta/reasoning.delta/tool.call 等扁平事件处理),对齐 AI SDK UIMessage
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { UIMessage } from 'ai';
import type { WebtoolEvent, WebtoolMessageMetadata, PersistedPart, InputResponse } from '@/lib/protocol/events';

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

// 把一条 WebtoolEvent 应用到 messages,返回新数组(不可变更新,触发 React 重渲染)
// 逻辑镜像 persist.persistSessionEvent(part.start/delta/update/end + message.metadata + turn.completed)
function applyEvent(messages: FrontendMessage[], event: WebtoolEvent): FrontendMessage[] {
  switch (event.type) {
    case 'part.start': {
      const { messages: m1, current } = getOrCreateCurrentAssistant(messages);
      // 注入 _pid(供后续 part.delta/update 定位),挂到 parts 末尾保序
      const part: PersistedPart = { ...event.part, _pid: event.partId } as PersistedPart;
      return m1.map((m) => (m === current ? { ...m, parts: [...m.parts, part] } : m));
    }
    case 'part.delta': {
      const { messages: m1, current } = getOrCreateCurrentAssistant(messages);
      const idx = findPartIndex(current.parts, event.partId);
      if (idx < 0) return messages; // part 不存在(不应发生),忽略防崩溃
      const parts = current.parts.slice();
      const p = { ...parts[idx] } as Record<string, unknown>;
      if (event.field === 'text' || event.field === 'reasoning') {
        // TextUIPart 和 ReasoningUIPart 文本字段都叫 text
        p.text = ((p.text as string) ?? '') + event.delta;
      } else if (event.field === 'input') {
        // tool input 是 JSON 片段累加(input-streaming 期间 input 存字符串,part.update 转 input-available 时替换为对象)
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
      // patch 浅合并到 part(state 变化、output、errorText、approval、preliminary、input 替换)
      const parts = current.parts.slice();
      parts[idx] = { ...parts[idx], ...event.patch } as PersistedPart;
      return m1.map((m) => (m === current ? { ...m, parts } : m));
    }
    case 'part.end': {
      const { messages: m1, current } = getOrCreateCurrentAssistant(messages);
      const idx = findPartIndex(current.parts, event.partId);
      if (idx < 0) return messages;
      // 带最终快照则替换(前端校正),保留 _pid
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
    case 'turn.completed': {
      // 落 finishReason + 收尾所有 state=streaming 的 part 为 done(与 persist 一致,
      // 防 eve 短 reasoning 不发 reasoning.completed 导致 part 卡 streaming)
      const { messages: m1, current } = getOrCreateCurrentAssistant(messages);
      const parts = current.parts.map((p) => {
        const pp = p as { state?: string };
        return pp.state === 'streaming' ? ({ ...p, state: 'done' } as PersistedPart) : p;
      });
      const metadata: WebtoolMessageMetadata = {
        ...current.metadata,
        finishReason: event.finishReason,
      };
      return m1.map((m) => (m === current ? { ...m, parts, metadata } : m));
    }
    // session.connected / session.disconnected / session.start 不影响 messages(在 onmessage 单独处理)
    default:
      return messages;
  }
}

export interface UseSessionMessagesResult {
  messages: FrontendMessage[];
  sending: boolean;
  disconnected: boolean;
  disconnectReason?: string;
  send: (content: string) => Promise<void>;
  stop: () => Promise<void>;
  retry: () => Promise<void>;
  dismissDisconnected: () => void;
  // 回答 HITL ask_question / tool-approval(eve input.requested):乐观更新 part + POST /input
  respondInput: (responses: InputResponse[]) => Promise<void>;
}

export function useSessionMessages(sessionId: string): UseSessionMessagesResult {
  const [messages, setMessages] = useState<FrontendMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [disconnectReason, setDisconnectReason] = useState<string | undefined>();

  // 加载历史 + 订阅 SSE
  useEffect(() => {
    let cancelled = false;
    // 加载历史:db rows(parts/metadata JSON 字符串)→ UIMessage[]
    fetch(`/api/sessions/${sessionId}/messages`)
      .then((res) => res.json())
      .then(
        (
          rows: Array<{
            id: string;
            role: string;
            parts: string;
            metadata: string | null;
          }>
        ) => {
          if (cancelled) return;
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
            return {
              id: r.id,
              role: r.role as UIMessage['role'],
              parts,
              metadata,
            };
          });
          setMessages(msgs);
        }
      );

    // 订阅 SSE:part.* 增量累积成 UIMessage
    const es = new EventSource(`/api/sessions/${sessionId}/events`);
    es.onmessage = (ev) => {
      let event: WebtoolEvent;
      try {
        event = JSON.parse(ev.data);
      } catch {
        return; // 非 JSON 事件忽略
      }
      // 会话级事件单独处理(不进 messages)
      if (event.type === 'session.disconnected') {
        setDisconnected(true);
        setDisconnectReason(event.reason);
        return;
      }
      if (event.type === 'session.start') {
        setDisconnected(false);
        setDisconnectReason(undefined);
        return;
      }
      // turn.completed:累积 + 解开 sending
      if (event.type === 'turn.completed') {
        setMessages((prev) => applyEvent(prev, event));
        setSending(false);
        return;
      }
      // part.* / message.metadata:累积到当前 assistant
      setMessages((prev) => applyEvent(prev, event));
    };

    return () => {
      cancelled = true;
      es.close();
    };
  }, [sessionId]);

  const send = useCallback(
    async (content: string) => {
      if (!content.trim() || sending) return;
      setSending(true);
      // 乐观插入 user 消息(前端立即显示,不等 db 回写)
      const userMsg: FrontendMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        parts: [{ type: 'text', text: content }],
      };
      setMessages((prev) => [...prev, userMsg]);

      // 超时兜底:服务端 60s 内未推 turn.completed 也不返回非 2xx,解开 sending 防输入框卡死
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('send timeout')), 60_000)
      );
      try {
        const res = await Promise.race([
          fetch(`/api/sessions/${sessionId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
          }),
          timeoutPromise,
        ]);
        if (!res.ok) {
          setSending(false);
          console.warn(`send failed: ${res.status}`);
        }
        // res.ok 时 turn.completed 会通过 SSE 到达并 setSending(false)
      } catch {
        setSending(false);
        console.warn('send network/timeout error');
      }
    },
    [sessionId, sending]
  );

  const stop = useCallback(async () => {
    if (!sending) return;
    try {
      await fetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
    } catch (err) {
      console.error('stop failed:', err);
    }
    // 不立即清 sending,等 turn.completed 自然到达;2s 安全兜底
    setTimeout(() => setSending(false), 2000);
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

  // 回答 HITL ask_question / tool-approval:对齐 eve client 的 client.input.responded 投影
  // 1) 本地乐观更新:把 requestId 对应的 dynamic-tool part 推到 approval-responded + 挂 toolMetadata.eve.inputResponse
  //    (用户立即看到"已回答";服务端 resume 后 action.result 会再把 state 推到 output-available,toolMetadata 浅合并保留 inputResponse)
  // 2) POST /input 让 adapter.send({ inputResponses }) 送达 eve(不设 sending:回答不锁输入框)
  const respondInput = useCallback(
    async (responses: InputResponse[]) => {
      if (responses.length === 0) return;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.role !== 'assistant') return m;
          let changed = false;
          const parts = m.parts.map((p) => {
            const meta = (p as { toolMetadata?: { eve?: { inputRequest?: { requestId?: string } } } }).toolMetadata;
            const req = meta?.eve?.inputRequest;
            if (!req) return p;
            const resp = responses.find((r) => r.requestId === req.requestId);
            if (!resp) return p;
            changed = true;
            // 浅合并 toolMetadata.eve,保留 inputRequest(只读展示)并挂 inputResponse(已回答)
            const existingMeta = (p as { toolMetadata?: { eve?: Record<string, unknown> } }).toolMetadata ?? {};
            const existingEve = existingMeta.eve ?? {};
            return {
              ...p,
              state: 'approval-responded',
              toolMetadata: {
                ...existingMeta,
                eve: { ...existingEve, inputResponse: resp },
              },
            } as PersistedPart;
          });
          return changed ? { ...m, parts } : m;
        })
      );
      try {
        await fetch(`/api/sessions/${sessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputResponses: responses }),
        });
      } catch (err) {
        console.error('respondInput failed:', err);
      }
    },
    [sessionId]
  );

  return { messages, sending, disconnected, disconnectReason, send, stop, retry, dismissDisconnected, respondInput };
}
