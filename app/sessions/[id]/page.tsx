'use client';

// SessionPage：会话路由入口。Composer 相关状态/行为已抽离到 _components/SessionComposer，
// 本文件只保留会话数据加载、消息渲染、消息操作和页面骨架。

import { useEffect, useMemo, useState, useCallback, useRef, memo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useSessionMessages } from '@/hooks/use-session-messages';
import type { FrontendMessage } from '@/hooks/use-session-messages';
import { MessageParts } from '@/components/chat/message-parts';
import { ThinkingMessage } from '@/components/chat/thinking-message';
import { InterruptBanner } from '@/components/chat/InterruptBanner';
import {
  extractMessagePlainText,
  MessageMeta,
} from '@/components/chat/message-meta';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
  messagesToMarkdown,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import { SpeechInput } from '@/components/ai-elements/speech-input';
import type { InputResponse } from '@/lib/protocol/events';
import { MAX_CHAT_MESSAGE_CHARS, getChatMessageLength } from '@/lib/chat/limits';
import { backendLabel } from '@/lib/backends/labels';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ComposerAttachments,
  ComposerLimitHint,
  ComposerSubmit,
  ComposerTextarea,
  SessionComposerProvider,
  useSessionComposer,
  useComposerSubmit,
} from './_components/SessionComposer';

// 空态建议 prompt
const EMPTY_SUGGESTIONS = [
  '帮我梳理一下这个项目的目录结构',
  '解释一下这段代码在做什么',
  '帮我写一个最小可运行的示例',
] as const;

interface SessionInfo {
  id: string;
  backend: string;
  model: string;
  targetId?: string;
  /** 本地后端工作目录；null/缺省 = client 默认 cwd */
  cwd?: string | null;
  title: string | null;
  userTitle: string | null;
}

type ModelOption = { id: string; label: string; isDefault?: boolean };

// 单条消息的渲染包成 memo'd 子组件
const MessageItem = memo(function MessageItem({
  m,
  actionsDisabled,
  onAction,
  onRespond,
}: {
  m: FrontendMessage;
  actionsDisabled: boolean;
  onAction: (kind: 'edit' | 'resend' | 'regenerate' | 'fork', messageId: string) => void;
  onRespond: (response: InputResponse) => void;
}) {
  const plain = useMemo(() => extractMessagePlainText(m.parts), [m.parts]);
  const createdAt = useMemo(
    () => (m.metadata as { createdAt?: string } | undefined)?.createdAt ?? null,
    [m.metadata],
  );
  return (
    <Message
      from={m.role}
      className={m.metadata?.optimistic ? 'opacity-90' : undefined}
    >
      <MessageContent>
        <MessageParts parts={m.parts} messageId={m.id} onRespond={onRespond} />
      </MessageContent>
      {(m.role === 'user' || m.role === 'assistant') && (
        <MessageMeta
          messageId={m.id}
          role={m.role}
          text={plain}
          createdAt={createdAt}
          actionsDisabled={actionsDisabled}
          onAction={onAction}
        />
      )}
    </Message>
  );
});

// 头部：返回 + 标题/后端徽章 + 下载
const SessionHeader = memo(function SessionHeader({
  displayTitle,
  backendName,
  modelName,
  cwdLabel,
  messages,
  sessionInfo,
}: {
  displayTitle: string;
  backendName: string | null;
  modelName: string | null;
  cwdLabel: string | null;
  messages: FrontendMessage[];
  sessionInfo: SessionInfo | null;
}) {
  const handleDownload = useCallback(() => {
    if (messages.length === 0) return;
    const markdown = messagesToMarkdown(messages);
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const safeTitle = (sessionInfo?.userTitle ?? sessionInfo?.title ?? 'conversation')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 40);
    link.download = `${safeTitle || 'conversation'}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast.success('已开始下载 Markdown');
  }, [messages, sessionInfo]);

  return (
    <header className="flex items-center gap-2 border-b bg-background px-4 py-3">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                href="/"
                className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
                aria-label="返回会话列表"
              />
            }
          >
            <ArrowLeft className="size-4" />
          </TooltipTrigger>
          <TooltipContent>返回会话列表</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium" title={displayTitle}>
            {displayTitle}
          </span>
          {backendName && (
            <Badge variant="outline" className="shrink-0 text-xs">
              {backendName}
            </Badge>
          )}
        </div>
        {(modelName || cwdLabel) && (
          <p
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={[modelName, cwdLabel ? `cwd: ${cwdLabel}` : null].filter(Boolean).join(' · ')}
          >
            {[modelName, cwdLabel ? `cwd: ${cwdLabel}` : null].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
                onClick={handleDownload}
                disabled={messages.length === 0}
                aria-label="下载对话为 Markdown"
              />
            }
          >
            <Download className="size-4" />
          </TooltipTrigger>
          <TooltipContent>
            {messages.length === 0 ? '暂无消息可下载' : '下载 Markdown'}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </header>
  );
});

// 空态
const EmptyConversation = memo(function EmptyConversation() {
  const {
    actions: { applySuggestion },
  } = useSessionComposer();
  return (
    <ConversationEmptyState
      title="开始对话"
      description="输入消息，或点下方建议快速开始"
    >
      <div className="mt-4 flex max-w-md flex-wrap justify-center gap-2">
        {EMPTY_SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => applySuggestion(s)}
            className="rounded-full border border-border bg-background px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-[0.99]"
          >
            {s}
          </button>
        ))}
      </div>
    </ConversationEmptyState>
  );
});

// 模型选择器
function ModelSelector({
  models,
  selectedModel,
  onSelect,
  disabled,
  fallbackLabel,
}: {
  models: ModelOption[];
  selectedModel: string;
  onSelect: (id: string) => void;
  disabled: boolean;
  fallbackLabel: string | null;
}) {
  if (models.length > 0) {
    return (
      <Select
        value={selectedModel}
        onValueChange={(value) => onSelect(value ?? '')}
        disabled={disabled}
      >
        <SelectTrigger size="sm" aria-label="选择本次消息使用的模型">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          <SelectGroup>
            {models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    );
  }
  if (fallbackLabel) {
    return (
      <span
        className="max-w-[10rem] truncate px-1 font-mono text-[11px] text-muted-foreground"
        title={fallbackLabel}
      >
        {fallbackLabel}
      </span>
    );
  }
  return null;
}

export default function SessionPage() {
  const params = useParams();
  const id = params.id as string;

  return (
    <SessionComposerProvider sessionId={id}>
      <SessionPageContent id={id} />
    </SessionComposerProvider>
  );
}

function SessionPageContent({ id }: { id: string }) {
  const router = useRouter();
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
    editResend,
    forkFrom,
  } = useSessionMessages(id);
  // append 语义：把语音转写文本追加到现有草稿后
  const appendInput = useAppendInput();

  const [retrying, setRetrying] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const lastSendErrorRef = useRef<string | null>(null);

  // 单 effect 一次拉 sessionInfo（含 availableModels 时一并下发），省掉本地后端 catalog 的第二轮 round-trip。
  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    fetch(`/api/sessions/${id}`, { signal: ac.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then(async (data: (SessionInfo & { availableModels?: ModelOption[] }) | null) => {
        if (cancelled || !data) return;
        setSessionInfo(data);
        setSelectedModel(data.model);
        if (Array.isArray(data.availableModels)) {
          applyModels(data.availableModels);
          return;
        }
        if (
          data.targetId &&
          (data.backend === 'claudecode' || data.backend === 'pi')
        ) {
          try {
            const res = await fetch(`/api/devices/${data.targetId}/models`, { signal: ac.signal });
            if (!res.ok) throw new Error(`模型列表加载失败: ${res.status}`);
            const rows = (await res.json()) as Array<{ backend: string; models: ModelOption[] }>;
            if (cancelled) return;
            const row = rows.find((item) => item.backend === data.backend);
            applyModels(Array.isArray(row?.models) ? row.models : []);
          } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') return;
            if (cancelled) return;
            setModels([]);
            toast.error(err instanceof Error ? err.message : '模型列表加载失败');
          }
        }
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return;
      });
    return () => {
      cancelled = true;
      ac.abort();
    };

    function applyModels(next: ModelOption[]) {
      setModels(next);
      if (next.length > 0) {
        setSelectedModel((current) =>
          next.some((model) => model.id === current)
            ? current
            : (next.find((model) => model.isDefault) ?? next[0]).id,
        );
      }
    }
  }, [id]);

  // sendError → toast（避免重复）
  useEffect(() => {
    if (sendError && sendError !== lastSendErrorRef.current) {
      lastSendErrorRef.current = sendError;
      toast.error(sendError);
    }
    if (!sendError) lastSendErrorRef.current = null;
  }, [sendError]);

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

  const showThinking = useMemo(() => {
    if (!sending) return false;
    const last = messages[messages.length - 1];
    if (last?.role !== 'assistant') return true;
    return !last.parts.some((p) => p.type === 'text' || p.type === 'reasoning');
  }, [messages, sending]);

  const hitlRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hasPendingInput) return;
    const t = setTimeout(() => {
      const reduceMotion =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
      hitlRef.current?.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'nearest',
      });
    }, 50);
    return () => clearTimeout(t);
  }, [hasPendingInput]);

  const {
    actions: { startEdit },
    state: { input, uploadRows, editingMessageId },
  } = useSessionComposer();
  const handleSubmit = useComposerSubmit({
    availableModels: models,
    editResend,
    editingMessageId,
    hasPendingInput,
    selectedModel,
    send,
    sending,
  });

  const handleEditMessage = useCallback(
    (messageId: string, text: string) => {
      startEdit(messageId, text);
    },
    [startEdit],
  );

  const handleResendMessage = useCallback(
    async (messageId: string) => {
      const ok = await editResend({
        messageId,
        mode: 'resend',
        ...(models.some((item) => item.id === selectedModel)
          ? { model: selectedModel }
          : {}),
      });
      if (!ok) toast.error('重发失败');
    },
    [editResend, models, selectedModel],
  );

  const handleRegenerate = useCallback(
    async (messageId: string) => {
      const ok = await editResend({
        messageId,
        mode: 'regenerate',
        ...(models.some((item) => item.id === selectedModel)
          ? { model: selectedModel }
          : {}),
      });
      if (!ok) toast.error('再生成失败');
    },
    [editResend, models, selectedModel],
  );

  const handleFork = useCallback(
    async (messageId: string) => {
      const newId = await forkFrom(messageId);
      if (!newId) {
        toast.error('创建分支失败');
        return;
      }
      toast.success('已创建分支会话');
      router.push(`/sessions/${newId}`);
    },
    [forkFrom, router],
  );

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const handleMessageAction = useCallback(
    (kind: 'edit' | 'resend' | 'regenerate' | 'fork', messageId: string) => {
      const m = messagesRef.current.find((mm) => mm.id === messageId);
      if (!m) return;
      const plain = extractMessagePlainText(m.parts);
      switch (kind) {
        case 'edit':
          handleEditMessage(messageId, plain);
          break;
        case 'resend':
          void handleResendMessage(messageId);
          break;
        case 'regenerate':
          void handleRegenerate(messageId);
          break;
        case 'fork':
          void handleFork(messageId);
          break;
      }
    },
    [handleEditMessage, handleResendMessage, handleRegenerate, handleFork],
  );

  const handleRespond = useCallback(
    (response: InputResponse) => {
      void respondInput([response]);
    },
    [respondInput]
  );

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await retry();
    } finally {
      setRetrying(false);
    }
  };

  const overMaxLength = getChatMessageLength(input) > MAX_CHAT_MESSAGE_CHARS;

  const displayTitle =
    sessionInfo?.userTitle?.trim() ||
    sessionInfo?.title?.trim() ||
    '对话';
  const backendName = sessionInfo ? backendLabel(sessionInfo.backend) : null;
  const modelName = selectedModel.trim() || sessionInfo?.model?.trim() || null;
  const cwdLabel =
    sessionInfo?.backend === 'claudecode' || sessionInfo?.backend === 'pi'
      ? (sessionInfo.cwd?.trim() || 'client 默认目录')
      : null;

  return (
      <div className="flex h-screen flex-col overflow-hidden">
        <SessionHeader
          backendName={backendName}
          cwdLabel={cwdLabel}
          displayTitle={displayTitle}
          messages={messages}
          modelName={modelName}
          sessionInfo={sessionInfo}
        />

        <InterruptBanner
          open={disconnected}
          reason={disconnectReason}
          busy={retrying}
          onRetry={handleRetry}
          onDismiss={dismissDisconnected}
        />
        {resuming && (
          <p className="flex items-center justify-center gap-1.5 border-b bg-muted/30 py-1 text-center text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            恢复中…
          </p>
        )}

        <Conversation>
          <ConversationContent className="mx-auto w-full max-w-3xl gap-6">
            {messages.length === 0 ? (
              <EmptyConversation />
            ) : (
              messages.map((m) => (
                <MessageItem
                  key={m.id}
                  m={m}
                  actionsDisabled={sending || hasPendingInput}
                  onAction={handleMessageAction}
                  onRespond={handleRespond}
                />
              ))
            )}
            <ThinkingMessage show={showThinking} />
            {hasPendingInput && <div ref={hitlRef} aria-hidden className="h-0" />}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="border-t p-4">
          <div className="mx-auto w-full max-w-3xl">
            {hasPendingInput && (
              <p className="mb-2 text-center text-xs text-muted-foreground">
                请先回答上方问题后再继续
              </p>
            )}
            {overMaxLength && (
              <p className="mb-2 text-center text-xs text-destructive">
                消息过长(上限 {MAX_CHAT_MESSAGE_CHARS} 字符,当前 {getChatMessageLength(input)}{' '}
                字符)
              </p>
            )}
            <PromptInput onSubmit={handleSubmit}>
              <PromptInputBody>
                <ComposerTextarea hasPendingInput={hasPendingInput} />
              </PromptInputBody>
              <PromptInputFooter>
                <PromptInputTools>
                  <ComposerAttachments hasPendingInput={hasPendingInput} />
                  <SpeechInput
                    lang="zh-CN"
                    disabled={hasPendingInput || sending}
                    className="size-7"
                    onTranscriptionChange={appendInput}
                    onAudioRecorded={async () => {
                      toast.message('当前浏览器不支持语音识别', {
                        description: '请使用 Chromium 系浏览器，或手动输入文字。',
                      });
                      return '';
                    }}
                  />
                  <ModelSelector
                    disabled={sending || hasPendingInput}
                    fallbackLabel={modelName}
                    models={models}
                    selectedModel={selectedModel}
                    onSelect={setSelectedModel}
                  />
                  <ComposerLimitHint />
                </PromptInputTools>
                <ComposerSubmit
                  hasPendingInput={hasPendingInput}
                  sending={sending}
                  uploadBusy={uploadRows.some((row) => row.status === 'uploading')}
                  onStop={() => void stop()}
                />
              </PromptInputFooter>
            </PromptInput>
          </div>
        </div>
      </div>
  );
}

// 辅助 hook：append 模式 setInput（保留原 page 中转写文本追加的语义）
// 必须放在 SessionComposerProvider 内部使用，因此与 SessionPage 同一个组件树。
function useAppendInput() {
  const {
    actions: { setInput },
  } = useSessionComposer();
  return useCallback(
    (text: string) => {
      const piece = text.trim();
      if (!piece) return;
      setInput((current) => {
        const base = current.trim();
        return base ? `${base} ${piece}` : piece;
      });
    },
    [setInput],
  );
}
