'use client';

import { useState, useMemo, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useSessionMessages } from '@/hooks/use-session-messages';
import { MessageParts } from '@/components/chat/message-parts';
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

// 会话页:用 ai-elements 渲染 UIMessage.parts(对齐 AI SDK / open-agents)
// 数据流:useSessionMessages 订阅 SSE part.* 事件累积成 UIMessage[](见 hooks/use-session-messages.ts)
// 渲染:Conversation/Message 容器 + MessageParts 分发器
//   (text→Streamdown, reasoning→Reasoning, tool→Tool, HITL inputRequest→InputRequestCard)
export default function SessionPage() {
  const params = useParams();
  const id = params.id as string;
  const {
    messages,
    sending,
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
          (p as { toolMetadata?: { eve?: { inputRequest?: unknown } } }).toolMetadata?.eve
            ?.inputRequest
        )
    );
  }, [messages]);

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

  // submit 按钮 disabled:sending 时可点(点 stop);否则 pending 或输入空时禁用
  const submitDisabled = sending ? false : hasPendingInput || !input.trim();

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
      <Conversation>
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState />
          ) : (
            messages.map((m) => (
              <Message key={m.id} from={m.role}>
                <MessageContent>
                  <MessageParts parts={m.parts} onRespond={handleRespond} />
                </MessageContent>
              </Message>
            ))
          )}
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
          <PromptInput onSubmit={handleSubmit}>
            <PromptInputBody>
              <PromptInputTextarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={hasPendingInput ? '等待回答…' : '输入消息…'}
                disabled={hasPendingInput}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>{/* 预留附件/工具按钮位 */}</PromptInputTools>
              {/* 一个按钮按 status 自动切换:ready→发送图标 / streaming→停止图标(点 onStop) */}
              <PromptInputSubmit
                status={sending ? 'streaming' : 'ready'}
                onStop={() => void stop()}
                disabled={submitDisabled}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </div>
  );
}
