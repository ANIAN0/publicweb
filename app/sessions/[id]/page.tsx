'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams } from 'next/navigation';
import { ToolCallCard } from '@/components/chat/ToolCallCard';
import { InterruptBanner } from '@/components/chat/InterruptBanner';

// 一条消息：用户 / 助手文本 / 思考 / 工具调用 / 工具结果
// 修复 REV-005-12：thinking 不再写进 content（避免  标签碎片），单独 reason 字段；
// toolCalls/toolResults 来自 DB 的 JSON 列，刷新后仍能渲染。
interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  reasoning?: string;
  toolCalls?: { id: string; name: string; input: unknown }[];
  toolResults?: { id: string; output: string; isError?: boolean }[];
}

export default function SessionPage() {
  const params = useParams();
  const id = params.id as string;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  // sending 表示正在生成中（turn 未结束）；点击"停止"会调 stop API 并立即解除
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  // 中断横幅：device 离线 / session.disconnected 时打开；用户点重试调 retry API
  const [disconnected, setDisconnected] = useState(false);
  const [disconnectReason, setDisconnectReason] = useState<string | undefined>();
  const [retrying, setRetrying] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 安全解析 DB 返回的 JSON 列；空/损坏值按空数组兜底，避免渲染崩溃
  function safeParse(s: string | null | undefined): any[] {
    if (!s) return [];
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  // 流式事件累积目标消息的 id：每个新 turn 第一次 delta/event 来临时分配一个新 id，
  // 该 turn 内所有 text/reasoning/tool 事件都挂这条消息上；turn.completed 后清空，下个 turn 再分配。
  // 修复 REV-005-12：固定 id='streaming' 在多轮下会引发 React key 重复警告，改成稳定唯一 id。
  const streamingIdRef = useRef<string | null>(null);
  const ensureStreamingId = (): string => {
    if (streamingIdRef.current) return streamingIdRef.current;
    const newId = `asst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    streamingIdRef.current = newId;
    setMessages((prev) => [...prev, { id: newId, role: 'assistant', content: '', reasoning: '' }]);
    return newId;
  };
  const updateStreamingMsg = (mutate: (m: Message) => Message) => {
    const targetId = ensureStreamingId();
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === targetId);
      if (idx === -1) return prev;
      const next = mutate(prev[idx]);
      return [...prev.slice(0, idx), next, ...prev.slice(idx + 1)];
    });
  };

  useEffect(() => {
    // 加载历史消息：DB 返回的 tool_calls/tool_results/reasoning 是 JSON 字符串或 null，
    // 这里统一反序列化并拍平成前端 Message 形状，刷新后历史里的 tool 卡片能重建（REV-005-12）。
    fetch(`/api/sessions/${id}/messages`)
      .then((res) => res.json())
      .then((rows: any[]) => {
        const msgs: Message[] = rows.map((r: any) => ({
          id: r.id,
          role: r.role,
          content: r.content ?? '',
          reasoning: r.reasoning ?? undefined,
          toolCalls: r.tool_calls ? safeParse(r.tool_calls) : undefined,
          toolResults: r.tool_results
            ? safeParse(r.tool_results).map((tr: any) => ({
                id: tr.toolCallId ?? tr.id,
                output: tr.output,
                isError: tr.isError,
              }))
            : undefined,
        }));
        setMessages(msgs);
      });

    // 订阅 SSE
    const eventSource = new EventSource(`/api/sessions/${id}/events`);
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'text.delta') {
        updateStreamingMsg((m) => ({ ...m, content: m.content + data.delta }));
      } else if (data.type === 'reasoning.delta') {
        // 单独 reasoning 字段；不要塞进 content（修复  标签碎片）
        updateStreamingMsg((m) => ({ ...m, reasoning: (m.reasoning ?? '') + data.delta }));
      } else if (data.type === 'tool.call') {
        updateStreamingMsg((m) => ({
          ...m,
          toolCalls: [...(m.toolCalls ?? []), { id: data.id, name: data.name, input: data.input }],
        }));
      } else if (data.type === 'tool.result') {
        updateStreamingMsg((m) => ({
          ...m,
          toolResults: [...(m.toolResults ?? []), { id: data.id, output: data.output, isError: data.isError }],
        }));
      } else if (data.type === 'turn.completed') {
        // turn 结束：解开发送状态、重置流式 id（让下一个 turn 拿到新的消息 id）
        streamingIdRef.current = null;
        setSending(false);
        setStopping(false);
      } else if (data.type === 'session.disconnected') {
        setDisconnected(true);
        setDisconnectReason(data.reason);
      } else if (data.type === 'session.start') {
        setDisconnected(false);
        setDisconnectReason(undefined);
      }
    };

    return () => eventSource.close();
  }, [id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    const content = input;
    setInput('');
    setMessages((prev) => [...prev, { id: 'user-' + Date.now(), role: 'user', content }]);

    // 超时兜底：若服务端在 SEND_TIMEOUT 内未推 turn.completed 也不返回非 2xx，
    // 解开发送状态，避免输入框永久卡死（防御对侧死锁/未关闭流）。
    const SEND_TIMEOUT_MS = 60_000;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const settleSending = (msg: string) => {
      if (timeoutId) clearTimeout(timeoutId);
      setSending(false);
      if (msg) console.warn(msg);
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('send timeout')), SEND_TIMEOUT_MS);
    });

    try {
      const res = await Promise.race([
        fetch(`/api/sessions/${id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        }),
        timeoutPromise,
      ]);
      // 修复 REV-005-11：必须检查 res.ok。否则非 2xx 时 sending 永不解锁，输入框卡死。
      if (!res.ok) {
        settleSending(`send failed: ${res.status}`);
      }
      // 即使 res.ok，turn.completed 事件最终会通过 SSE 到达并 setSending(false)。
      // 这里若超时/失败发生，立即解锁；正常路径交由 SSE 处理。
    } catch {
      settleSending('send network/timeout error');
    }
  };

  // 主动停止：调 POST /stop；stopping 状态给按钮反馈；SSE 的 turn.completed 会最终解开 sending
  const handleStop = async () => {
    if (!sending || stopping) return;
    setStopping(true);
    try {
      await fetch(`/api/sessions/${id}/stop`, { method: 'POST' });
    } catch (err) {
      console.error('stop failed:', err);
    } finally {
      // 不立即清 sending，等 turn.completed 自然到达；这里加 2s 安全兜底
      setTimeout(() => setSending(false), 2000);
      setStopping(false);
    }
  };

  // 重试：调 POST /retry；服务端会派发 session.start 给 device（device 离线则 503）
  const handleRetry = async () => {
    setRetrying(true);
    try {
      const res = await fetch(`/api/sessions/${id}/retry`, { method: 'POST' });
      if (res.ok) {
        setDisconnected(false);
        setDisconnectReason(undefined);
      } else {
        console.error('retry failed:', await res.text());
      }
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="flex flex-col h-screen">
      {/* 中断横幅 sticky 在消息流顶部，不挡输入框 */}
      <InterruptBanner
        open={disconnected}
        reason={disconnectReason}
        busy={retrying}
        onRetry={handleRetry}
        onDismiss={() => setDisconnected(false)}
      />
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] p-3 rounded-lg ${
              msg.role === 'user' ? 'bg-blue-500 text-white' : 'bg-zinc-200 dark:bg-zinc-800 text-black dark:text-white'
            }`}>
              {/* 思考块：折叠展示，不污染主内容（REV-005-12） */}
              {msg.role === 'assistant' && msg.reasoning && (
                <details className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <summary className="cursor-pointer select-none">思考</summary>
                  <pre className="whitespace-pre-wrap mt-1 italic">{msg.reasoning}</pre>
                </details>
              )}
              {msg.content && <div className="whitespace-pre-wrap">{msg.content}</div>}
              {msg.toolCalls?.map((tc) => {
                // 找匹配的 tool result
                const result = msg.toolResults?.find((tr) => tr.id === tc.id);
                return (
                  <ToolCallCard
                    key={tc.id}
                    toolName={tc.name}
                    input={tc.input}
                    output={result?.output}
                    isError={result?.isError}
                  />
                );
              })}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="p-4 border-t">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            // 仅在 generating 时禁用输入；stopped 后立刻可发
            disabled={sending}
            className="flex-1 p-2 border rounded disabled:opacity-50"
            placeholder="输入消息..."
          />
          {sending ? (
            <button
              onClick={handleStop}
              disabled={stopping}
              className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 disabled:opacity-50"
            >
              {stopping ? '停止中...' : '停止'}
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}