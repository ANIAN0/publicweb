'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Download, Loader2, Paperclip, RotateCcw, X } from 'lucide-react';
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
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  type PromptInputMessage,
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

/** 附件上传态：idle 芯片 / uploading / done / failed+重试 */
type UploadRow = {
  localId: string;
  filename: string;
  status: 'queued' | 'uploading' | 'done' | 'failed';
  error?: string;
  /** 原始 PromptInput 文件（data/blob url） */
  sourceUrl: string;
  mediaType: string;
  result?: { id: string; filename: string; mediaType: string; size?: number; url?: string };
};

// 附件工具条：选文件 + 上传进度/失败重试
function ComposerAttachments({
  disabled,
  uploadRows,
  onRetry,
  onDismissUpload,
}: {
  disabled?: boolean;
  uploadRows: UploadRow[];
  onRetry?: (localId: string) => void;
  /** PAGE-003：关闭失败/残留上传 chip */
  onDismissUpload?: (localId: string) => void;
}) {
  const attachments = usePromptInputAttachments();
  return (
    <>
      <TooltipProvider>
        <Tooltip>
          {/* Base UI：用 render 合并触发元素，避免 TooltipTrigger 默认 button 再嵌套 button */}
          <TooltipTrigger
            render={
              <button
                type="button"
                disabled={disabled}
                className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
                onClick={() => attachments.openFileDialog()}
                aria-label="添加附件"
              />
            }
          >
            <Paperclip className="size-4" />
          </TooltipTrigger>
          <TooltipContent>添加附件（单文件 ≤5MB）</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {/* 上传中/失败态（优先于静态 chip） */}
      {uploadRows.length > 0 ? (
        <div className="flex max-w-[14rem] flex-wrap gap-1">
          {uploadRows.map((row) => (
            <span
              key={row.localId}
              className={
                row.status === 'failed'
                  ? 'inline-flex max-w-full items-center gap-0.5 rounded-md bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive'
                  : row.status === 'done'
                    ? 'inline-flex max-w-full items-center gap-0.5 rounded-md bg-success/10 px-1.5 py-0.5 text-[10px] text-success'
                    : 'inline-flex max-w-full items-center gap-0.5 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground'
              }
              title={row.error}
            >
              {row.status === 'uploading' || row.status === 'queued' ? (
                <Loader2 className="size-2.5 shrink-0 animate-spin" aria-hidden />
              ) : null}
              <span className="truncate">{row.filename}</span>
              {row.status === 'failed' && onRetry ? (
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 hover:bg-background"
                  onClick={() => onRetry(row.localId)}
                  aria-label={`重试 ${row.filename}`}
                >
                  <RotateCcw className="size-2.5" />
                </button>
              ) : null}
              {(row.status === 'failed' || row.status === 'done') && onDismissUpload ? (
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 hover:bg-background"
                  onClick={() => onDismissUpload(row.localId)}
                  aria-label={`关闭 ${row.filename}`}
                >
                  <X className="size-2.5" />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : attachments.files.length > 0 ? (
        <div className="flex max-w-[12rem] flex-wrap gap-1">
          {attachments.files.map((f) => (
            <span
              key={f.id}
              className="inline-flex max-w-full items-center gap-0.5 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              <span className="truncate">{f.filename ?? '文件'}</span>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 hover:bg-background"
                onClick={() => attachments.remove(f.id)}
                aria-label={`移除 ${f.filename ?? '文件'}`}
              >
                <X className="size-2.5" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

// 发送按钮：有附件时允许无文本提交（须在 PromptInput 子树内读 attachments）
function ComposerSubmit({
  sending,
  hasPendingInput,
  overMaxLength,
  textEmpty,
  uploadBusy,
  sendError,
  onStop,
}: {
  sending: boolean;
  hasPendingInput: boolean;
  overMaxLength: boolean;
  textEmpty: boolean;
  uploadBusy: boolean;
  sendError: string | null;
  onStop: () => void;
}) {
  const attachments = usePromptInputAttachments();
  const hasFiles = attachments.files.length > 0;
  const submitDisabled = sending
    ? false
    : hasPendingInput || uploadBusy || overMaxLength || (textEmpty && !hasFiles);
  const disabledReason = sending
    ? undefined
    : hasPendingInput
      ? '请先回答上方问题'
      : uploadBusy
        ? '附件正在上传'
        : overMaxLength
          ? `消息过长(上限 ${MAX_CHAT_MESSAGE_CHARS} 字符)`
          : textEmpty && !hasFiles
            ? '请输入消息或添加附件'
            : sendError ?? undefined;
  return (
    <PromptInputSubmit
      status={sending ? 'streaming' : 'ready'}
      onStop={onStop}
      disabled={submitDisabled}
      disabledReason={disabledReason}
    />
  );
}

export default function SessionPage() {
  const params = useParams();
  const router = useRouter();
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
    editResend,
    forkFrom,
  } = useSessionMessages(id);
  const [input, setInput] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  // 编辑中的 user messageId：提交时走 edit-resend 而非普通 send
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  // 附件上传状态机（queued → uploading → done | failed）
  const [uploadRows, setUploadRows] = useState<UploadRow[]>([]);
  const lastSendErrorRef = useRef<string | null>(null);
  // PAGE-001：用 ref 绑 composer textarea，禁止 document.querySelector('textarea')
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  /** 上传单个附件到 /attachments，返回元数据或 null */
  const uploadOne = useCallback(
    async (row: Pick<UploadRow, 'localId' | 'filename' | 'sourceUrl' | 'mediaType'>): Promise<UploadRow['result'] | null> => {
      setUploadRows((prev) =>
        prev.map((r) =>
          r.localId === row.localId ? { ...r, status: 'uploading', error: undefined } : r,
        ),
      );
      try {
        const blob = await fetch(row.sourceUrl).then((r) => r.blob());
        const form = new FormData();
        form.append('file', blob, row.filename);
        const res = await fetch(`/api/sessions/${id}/attachments`, {
          method: 'POST',
          body: form,
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(errBody.error ?? `HTTP ${res.status}`);
        }
        const meta = (await res.json()) as {
          id: string;
          filename: string;
          mediaType: string;
          size?: number;
          url?: string;
        };
        setUploadRows((prev) =>
          prev.map((r) =>
            r.localId === row.localId ? { ...r, status: 'done', result: meta } : r,
          ),
        );
        return meta;
      } catch (err) {
        const msg = err instanceof Error ? err.message : '上传失败';
        setUploadRows((prev) =>
          prev.map((r) =>
            r.localId === row.localId ? { ...r, status: 'failed', error: msg } : r,
          ),
        );
        return null;
      }
    },
    [id],
  );

  const retryUpload = useCallback(
    (localId: string) => {
      const row = uploadRows.find((r) => r.localId === localId);
      if (!row || row.status !== 'failed') return;
      void uploadOne(row);
    },
    [uploadRows, uploadOne],
  );

  // APP-023：关键 fetch 用 AbortController，卸载时取消
  useEffect(() => {
    const ac = new AbortController();
    fetch(`/api/sessions/${id}`, { signal: ac.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: SessionInfo | null) => {
        if (data) {
          setSessionInfo(data);
          setSelectedModel(data.model);
        }
      })
      .catch((err: unknown) => {
        // AbortError 属正常取消，忽略
        if (err instanceof Error && err.name === 'AbortError') return;
      });
    return () => ac.abort();
  }, [id]);

  // 本地执行端的 catalog 来自 client 上行缓存；只在 target/session 就绪后请求。
  useEffect(() => {
    if (
      !sessionInfo?.targetId ||
      (sessionInfo.backend !== 'claudecode' && sessionInfo.backend !== 'pi')
    ) {
      setModels([]);
      return;
    }
    const ac = new AbortController();
    setModels([]);
    fetch(`/api/devices/${sessionInfo.targetId}/models`, { signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`模型列表加载失败: ${res.status}`);
        return res.json() as Promise<Array<{ backend: string; models: ModelOption[] }>>;
      })
      .then((rows) => {
        const row = rows.find((item) => item.backend === sessionInfo.backend);
        const next = Array.isArray(row?.models) ? row.models : [];
        setModels(next);
        if (next.length > 0) {
          setSelectedModel((current) =>
            next.some((model) => model.id === current)
              ? current
              : (next.find((model) => model.isDefault) ?? next[0]).id,
          );
        }
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        setModels([]);
        toast.error(err instanceof Error ? err.message : '模型列表加载失败');
      });
    return () => ac.abort();
  }, [sessionInfo?.backend, sessionInfo?.targetId]);

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
    if (hasPendingInput) {
      const t = setTimeout(() => {
        hitlRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
      return () => clearTimeout(t);
    }
  }, [hasPendingInput]);

  const handleSubmit = async (message: PromptInputMessage) => {
    const content = message.text ?? '';
    const files = message.files ?? [];
    if (sending || hasPendingInput || uploadRows.some((row) => row.status === 'uploading')) {
      return false;
    }

    // 编辑模式：截断并重发（编辑路径暂不混附件，避免与截断语义纠缠）
    if (editingMessageId) {
      if (!content.trim()) return false;
      const mid = editingMessageId;
      const draft = content.trim();
      setEditingMessageId(null);
      setInput('');
      const ok = await editResend({
        messageId: mid,
        mode: 'edit',
        content: draft,
        ...(models.some((item) => item.id === selectedModel)
          ? { model: selectedModel }
          : {}),
      });
      if (!ok) {
        // 与 HOOK-004 一致：失败恢复草稿，便于重试
        setInput(draft);
        setEditingMessageId(mid);
        toast.error('编辑重发失败');
        return false;
      }
      return true;
    }

    if (!content.trim() && files.length === 0) return false;

    // PAGE-003：纯文本发送时清掉上一次失败/残留的上传 chips
    if (files.length === 0) {
      setUploadRows([]);
    }

    // 附件状态机：queued → uploading → done|failed；失败可点重试
    const uploaded: Array<{ id: string; filename: string; mediaType: string; size?: number; url?: string }> = [];
    if (files.length > 0) {
      const rows: UploadRow[] = files.map((f, i) => {
        const filename = f.filename ?? 'file';
        const sourceUrl = f.url ?? '';
        const mediaType = f.mediaType ?? 'application/octet-stream';
        const reusable = uploadRows.find((row) =>
          row.filename === filename &&
          row.sourceUrl === sourceUrl &&
          row.mediaType === mediaType &&
          row.status === 'done' &&
          row.result,
        );
        return reusable ?? {
          localId: `up-${Date.now()}-${i}-${filename}`,
          filename,
          status: 'queued' as const,
          sourceUrl,
          mediaType,
        };
      });
      if (rows.some((r) => !r.sourceUrl)) {
        toast.error('附件无效', { description: '缺少文件数据' });
        setUploadRows([]);
        return false;
      }
      setUploadRows(rows);

      for (const row of rows) {
        const meta = row.status === 'done' && row.result
          ? row.result
          : await uploadOne(row);
        if (!meta) {
          toast.error('附件上传失败', {
            description: `${row.filename}：可点芯片上的重试，或移除附件后仅发文本`,
          });
          return false;
        }
        uploaded.push(meta);
      }
    }

    // HOOK-004：先清空 UI；send 失败则恢复草稿
    setInput('');
    setUploadRows([]);
    const ok = await send(
      content,
      {
        ...(uploaded.length ? { attachments: uploaded } : {}),
        ...(models.some((item) => item.id === selectedModel)
          ? { model: selectedModel }
          : {}),
      },
    );
    if (!ok) {
      setInput(content);
      toast.error('发送失败，草稿已恢复');
      return false;
    }
    return true;
  };

  const handleEditMessage = useCallback((messageId: string, text: string) => {
    setEditingMessageId(messageId);
    setInput(text);
    toast.message('正在编辑消息', {
      description: '修改后发送将截断后续回复并重跑。',
    });
    // PAGE-001：ref 聚焦 composer
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
    });
  }, []);

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

  const applySuggestion = useCallback((text: string) => {
    setInput(text);
    // PAGE-001：ref 聚焦 composer
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
    });
  }, []);

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

  const overMaxLength = getChatMessageLength(input) > MAX_CHAT_MESSAGE_CHARS;
  // 纯文本校验；带附件时由 ComposerSubmit 内用 attachments.files 放行
  const textEmpty = !input.trim();

  const displayTitle =
    sessionInfo?.userTitle?.trim() ||
    sessionInfo?.title?.trim() ||
    '对话';
  const backendName = sessionInfo ? backendLabel(sessionInfo.backend) : null;
  const modelName = selectedModel.trim() || sessionInfo?.model?.trim() || null;
  // 工作目录：仅 local 后端有意义；空则 client 默认
  const cwdLabel =
    sessionInfo?.backend === 'claudecode' || sessionInfo?.backend === 'pi'
      ? (sessionInfo.cwd?.trim() || 'client 默认目录')
      : null;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
        <header className="flex items-center gap-2 border-b bg-background px-4 py-3">
          <TooltipProvider>
            <Tooltip>
              {/* Link 作为触发元素，避免默认 button 包裹 <a> */}
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
            {/* 副行：模型 + 工作目录（只读展示，不进页拉 models） */}
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
              {/* render 合并：外层不再多包一层 button，修复 hydration 嵌套 button 报错 */}
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
              // PAGE-002：只用 ConversationEmptyState 的 title/description，避免子节点重复标题
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
            ) : (
              messages.map((m) => {
                const plain = extractMessagePlainText(m.parts);
                const createdAt =
                  (m.metadata as { createdAt?: string } | undefined)?.createdAt ?? null;
                return (
                  <Message
                    key={m.id}
                    from={m.role}
                    className={m.metadata?.optimistic ? 'opacity-90' : undefined}
                  >
                    <MessageContent>
                      <MessageParts parts={m.parts} onRespond={handleRespond} />
                    </MessageContent>
                    {(m.role === 'user' || m.role === 'assistant') && (
                      <MessageMeta
                        role={m.role}
                        text={plain}
                        createdAt={createdAt}
                        actionsDisabled={sending || hasPendingInput}
                        onEdit={
                          m.role === 'user' && plain
                            ? () => handleEditMessage(m.id, plain)
                            : undefined
                        }
                        onResend={
                          m.role === 'user' && plain
                            ? () => void handleResendMessage(m.id)
                            : undefined
                        }
                        onRegenerate={
                          m.role === 'assistant'
                            ? () => void handleRegenerate(m.id)
                            : undefined
                        }
                        onFork={() => void handleFork(m.id)}
                      />
                    )}
                  </Message>
                );
              })
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
                <PromptInputTextarea
                  ref={composerTextareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={
                    hasPendingInput
                      ? '等待回答…'
                      : editingMessageId
                        ? '编辑消息后发送（将截断后续）…'
                        : '输入消息…'
                  }
                  disabled={hasPendingInput}
                  autoFocus={!sending}
                />
              </PromptInputBody>
              <PromptInputFooter
                footerStart={
                  <PromptInputTools>
                    {/* 附件：选文件 / 粘贴由 PromptInput 内置处理 */}
                    <ComposerAttachments
                      disabled={hasPendingInput || uploadRows.some((r) => r.status === 'uploading')}
                      uploadRows={uploadRows}
                      onRetry={retryUpload}
                      onDismissUpload={(localId) =>
                        setUploadRows((prev) => prev.filter((r) => r.localId !== localId))
                      }
                    />
                    {/* 语音：Web Speech API → 填入输入框，无协议变更 */}
                    <SpeechInput
                      lang="zh-CN"
                      disabled={hasPendingInput || sending}
                      className="size-7"
                      onTranscriptionChange={(text) => {
                        // 追加转写结果，保留已有草稿
                        setInput((prev) => {
                          const base = prev.trim();
                          const piece = text.trim();
                          if (!piece) return prev;
                          return base ? `${base} ${piece}` : piece;
                        });
                      }}
                      onAudioRecorded={async () => {
                        // 无 Web Speech 的浏览器（部分 Firefox/Safari）：无自建 STT 时明确提示，禁止静默丢录音
                        toast.message('当前浏览器不支持语音识别', {
                          description: '请使用 Chromium 系浏览器，或手动输入文字。',
                        });
                        return '';
                      }}
                    />
                    {models.length > 0 ? (
                      <Select
                        value={selectedModel}
                        onValueChange={(value) => setSelectedModel(value ?? '')}
                        disabled={sending || hasPendingInput}
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
                    ) : modelName ? (
                      <span
                        className="max-w-[10rem] truncate px-1 font-mono text-[11px] text-muted-foreground"
                        title={modelName}
                      >
                        {modelName}
                      </span>
                    ) : null}
                    {input.length > 0 && (
                      <span
                        className={
                          overMaxLength
                            ? 'px-1 text-[11px] tabular-nums text-destructive'
                            : 'px-1 text-[11px] tabular-nums text-muted-foreground'
                        }
                      >
                        {getChatMessageLength(input)}/{MAX_CHAT_MESSAGE_CHARS}
                      </span>
                    )}
                  </PromptInputTools>
                }
              >
                <ComposerSubmit
                  sending={sending}
                  hasPendingInput={hasPendingInput}
                  overMaxLength={overMaxLength}
                  textEmpty={textEmpty}
                  uploadBusy={uploadRows.some((row) => row.status === 'uploading')}
                  sendError={sendError}
                  onStop={() => void stop()}
                />
              </PromptInputFooter>
            </PromptInput>
          </div>
        </div>
    </div>
  );
}
