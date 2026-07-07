'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { useSessionMessages } from '@/hooks/use-session-messages';
import { MessageParts } from '@/components/chat/message-parts';
import { ThinkingMessage } from '@/components/chat/thinking-message';
import { InterruptBanner } from '@/components/chat/InterruptBanner';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import type { InputResponse } from '@/lib/protocol/events';
import { MAX_CHAT_MESSAGE_CHARS, getChatMessageLength } from '@/lib/chat/limits';

// 会话页:用 ai-elements 渲染 UIMessage.parts(对齐 AI SDK / open-agents)
// 数据流:useSessionMessages 订阅 SSE part.* 事件累积成 UIMessage[](见 hooks/use-session-messages.ts)
// 渲染:Conversation/Message 容器 + MessageParts 分发器
//   (text→Streamdown, reasoning→Reasoning, tool→Tool, HITL inputRequest 嵌 Tool 内 InputRequestActions)
export default function SessionPage() {
  const params = useParams();
  const id = params.id as string;
  const {
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
  } = useSessionMessages(id);
  const [input, setInput] = useState('');
  // 重试中状态(给 InterruptBanner busy 反馈);hook 的 retry 是 async,这里包装加状态
  const [retrying, setRetrying] = useState(false);

  // 检测 pending HITL 问题:最后一条 assistant 消息有 state=approval-requested 的 inputRequest part
  // eve session.waiting(parked)时需用户先回答,输入框 disabled(对齐 eve parked session 语义)
  const hasPendingInput = useMemo(() => {
    const last = messages[messages.length - 1];
    if (last?.role !== 'assistant') return false;
    return last.parts.some(
      (p) =>
        p.type === 'dynamic-tool' &&
        p.state === 'approval-requested' &&
        Boolean(
          (p as { toolMetadata?: { inputRequest?: unknown } }).toolMetadata?.inputRequest
        )
    );
  }, [messages]);

  // busy 无可见 part 时显示 ThinkingMessage(sending 且当前 turn 最后 assistant 无 text/reasoning part)
  const showThinking = useMemo(() => {
    if (!sending) return false;
    const last = messages[messages.length - 1];
    if (last?.role !== 'assistant') return true;  // 刚发消息,agent 还没开 part
    return !last.parts.some((p) => p.type === 'text' || p.type === 'reasoning');
  }, [messages, sending]);

  // hasPendingInput 时滚动到 HITL(最后一条 assistant 含 inputRequest Tool,T-011 布局对齐)
  const hitlRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (hasPendingInput) {
      // 微延后等 DOM 渲染 HITL Tool 展开(defaultOpen)
      const t = setTimeout(() => {
        hitlRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
      return () => clearTimeout(t);
    }
  }, [hasPendingInput]);

  // PromptInput onSubmit:message.text 是 textarea 值;提交后清空 + 触发 send
  const handleSubmit = (message: { text: string }) => {
    const content = message.text;
    // sending 中 / 有 pending HITL 问题时禁止发新消息
    if (!content.trim() || sending || hasPendingInput) return;
    setInput('');
    void send(content);
  };

  // HITL 回答回调:单个 response 包成数组交给 respondInput(乐观更新 + POST /input)
  const handleRespond = useCallback(
    (response: InputResponse) => {
      void respondInput([response]);
    },
    [respondInput]
  );

  // 重试:包装 retry 加 retrying 状态
  const handleRetry = async () => {
    setRetrying(true);
    try {
      await retry();
    } finally {
      setRetrying(false);
    }
  };

  // submit 按钮 disabled:sending 时可点(点 stop);否则 pending/超长/输入空时禁用
  const overMaxLength = getChatMessageLength(input) > MAX_CHAT_MESSAGE_CHARS;  // T-012:超长按钮变灰(Unicode 码点计数)
  const submitDisabled = sending ? false : hasPendingInput || overMaxLength || !input.trim();
  // T-012:禁用原因(sending 时 stop 可点无 reason;否则按 pending/超长/发送失败提示)
  const disabledReason = sending
    ? undefined
    : hasPendingInput
      ? '请先回答上方问题'
      : overMaxLength
        ? `消息过长(上限 ${MAX_CHAT_MESSAGE_CHARS} 字符)`
        : sendError ?? undefined;

  return (
    <div className="flex h-screen flex-col">
      {/* 中断横幅:device 离线 / session.disconnected 时显示 */}
      <InterruptBanner
        open={disconnected}
        reason={disconnectReason}
        busy={retrying}
        onRetry={handleRetry}
        onDismiss={dismissDisconnected}
      />
      {resuming && (
        <p className="border-b bg-muted/30 py-1 text-center text-xs text-muted-foreground">
          恢复中…
        </p>
      )}
      <Conversation>
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {messages.length === 0 ? (
            <ConversationEmptyState />
          ) : (
            messages.map((m) => (
              <Message key={m.id} from={m.role} className={m.metadata?.optimistic ? 'opacity-90' : undefined}>
                <MessageContent>
                  <MessageParts parts={m.parts} onRespond={handleRespond} />
                </MessageContent>
              </Message>
            ))
          )}
          {/* busy 无可见 part 时显示 Thinking...(淡出由 useThinkingPresence 控制) */}
          <ThinkingMessage show={showThinking} />
          {/* hasPendingInput 时滚动到 HITL(最后一条 assistant 含 inputRequest Tool) */}
          {hasPendingInput && <div ref={hitlRef} aria-hidden className="h-0" />}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="border-t p-4">
        {/* max-w-3xl 居中:与消息列表宽度对齐,避免输入框贴满屏宽 */}
        <div className="mx-auto w-full max-w-3xl">
          {hasPendingInput && (
            <p className="mb-2 text-center text-xs text-muted-foreground">
              请先回答上方问题后再继续
            </p>
          )}
          {/* T-012:send 失败/超时用户可见反馈(非仅 console.warn) */}
          {sendError && (
            <p className="mb-2 text-center text-xs text-destructive">{sendError}</p>
          )}
          {/* T-012:超长错误提示(不静默截断) */}
          {overMaxLength && (
            <p className="mb-2 text-center text-xs text-destructive">
              消息过长(上限 {MAX_CHAT_MESSAGE_CHARS} 字符,当前 {getChatMessageLength(input)} 字符)
            </p>
          )}
          <PromptInput onSubmit={handleSubmit}>
            <PromptInputBody>
              <PromptInputTextarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={hasPendingInput ? '等待回答…' : '输入消息…'}
                disabled={hasPendingInput}
                autoFocus={!sending}  // T-012:ready 时 rAF focus
              />
            </PromptInputBody>
            <PromptInputFooter footerStart={<PromptInputTools>{/* 预留附件/工具按钮位 */}</PromptInputTools>}>
              {/* 一个按钮按 status 自动切换:ready→发送图标 / streaming→停止图标(点 onStop) */}
              <PromptInputSubmit
                status={sending ? 'streaming' : 'ready'}
                onStop={() => void stop()}
                disabled={submitDisabled}
                disabledReason={disabledReason}  // T-012:disabled 时 title 提示
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </div>
  );
}
