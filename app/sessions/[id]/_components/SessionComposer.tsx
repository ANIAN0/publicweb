'use client';

// SessionComposer：会话级 composer 的状态 + 行为封装。
// 把 923 行 SessionPage 中属于 composer 的 useState/handlers 抽到这里，
// 通过 Context 把 state/actions/meta 暴露给 ComposerTextarea / ComposerAttachments / ComposerSubmit 等独立组件。

import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Loader2, Paperclip, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import { buttonVariants } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputAttachments,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input';
import {
  MAX_CHAT_MESSAGE_CHARS,
  getChatMessageLength,
} from '@/lib/chat/limits';
import { cn } from '@/lib/utils';
import { createContext, use } from 'react';

// 附件上传态：idle 芯片 / uploading / done / failed+重试
export type UploadRow = {
  localId: string;
  filename: string;
  status: 'queued' | 'uploading' | 'done' | 'failed';
  error?: string;
  /** 原始 PromptInput 文件（data/blob url） */
  sourceUrl: string;
  mediaType: string;
  result?: { id: string; filename: string; mediaType: string; size?: number; url?: string };
};

interface SessionComposerState {
  input: string;
  uploadRows: UploadRow[];
  editingMessageId: string | null;
}

interface SessionComposerActions {
  /** 直接赋值；也支持函数式更新（append 场景） */
  setInput: (next: string | ((current: string) => string)) => void;
  startEdit: (messageId: string, text: string) => void;
  cancelEdit: () => void;
  retryUpload: (localId: string) => void;
  dismissUpload: (localId: string) => void;
  applySuggestion: (text: string) => void;
  resetDraftAfterSend: () => void;
  restoreDraft: (input: string, editingMessageId: string | null) => void;
  /** Page 层调用：在发送前合并上传文件并填充到 uploadRows；返回上传成功的元数据 */
  prepareFilesForSend: (files: { filename?: string; url?: string; mediaType?: string }[]) => Promise<
    Array<{ id: string; filename: string; mediaType: string; size?: number; url?: string }>
  >;
}

interface SessionComposerMeta {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

interface SessionComposerContextValue {
  state: SessionComposerState;
  actions: SessionComposerActions;
  meta: SessionComposerMeta;
}

const SessionComposerContext = createContext<SessionComposerContextValue | null>(
  null,
);

export const useSessionComposer = () => {
  const ctx = use(SessionComposerContext);
  if (!ctx) {
    throw new Error(
      'useSessionComposer must be used within SessionComposerProvider',
    );
  }
  return ctx;
};

// ============================================================================
// Provider
// ============================================================================

interface SessionComposerProviderProps {
  sessionId: string;
  children: React.ReactNode;
}

export const SessionComposerProvider = ({
  sessionId,
  children,
}: SessionComposerProviderProps) => {
  const [input, setInputState] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [uploadRows, setUploadRows] = useState<UploadRow[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  /** 上传单个附件到 /attachments，返回元数据或 null */
  const uploadOne = useCallback(
    async (
      row: Pick<UploadRow, 'localId' | 'filename' | 'sourceUrl' | 'mediaType'>,
    ): Promise<UploadRow['result'] | null> => {
      setUploadRows((prev) =>
        prev.map((r) =>
          r.localId === row.localId
            ? { ...r, status: 'uploading', error: undefined }
            : r,
        ),
      );
      try {
        const blob = await fetch(row.sourceUrl).then((r) => r.blob());
        const form = new FormData();
        form.append('file', blob, row.filename);
        const res = await fetch(
          `/api/sessions/${sessionId}/attachments`,
          { method: 'POST', body: form },
        );
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
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
    [sessionId],
  );

  const retryUpload = useCallback(
    (localId: string) => {
      const row = uploadRows.find((item) => item.localId === localId);
      if (!row || row.status !== 'failed') return;
      void uploadOne(row);
    },
    [uploadOne, uploadRows],
  );

  const dismissUpload = useCallback((localId: string) => {
    setUploadRows((prev) => prev.filter((r) => r.localId !== localId));
  }, []);

  const setInput = useCallback((next: string | ((current: string) => string)) => {
    setInputState((prev) => (typeof next === 'function' ? next(prev) : next));
  }, []);

  const startEdit = useCallback((messageId: string, text: string) => {
    setEditingMessageId(messageId);
    setInputState(text);
    toast.message('正在编辑消息', {
      description: '修改后发送将截断后续回复并重跑。',
    });
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingMessageId(null);
  }, []);

  const applySuggestion = useCallback((text: string) => {
    setInput(text);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, []);

  const resetDraftAfterSend = useCallback(() => {
    setInput('');
    setUploadRows([]);
    setEditingMessageId(null);
  }, []);

  const restoreDraft = useCallback(
    (draftInput: string, draftEditingMessageId: string | null) => {
      setInput(draftInput);
      setEditingMessageId(draftEditingMessageId);
    },
    [],
  );

  const prepareFilesForSend = useCallback(
    async (
      files: { filename?: string; url?: string; mediaType?: string }[],
    ) => {
      const uploaded: Array<{
        id: string;
        filename: string;
        mediaType: string;
        size?: number;
        url?: string;
      }> = [];
      if (files.length === 0) return uploaded;

      // 复用上次成功上传的元数据，避免重复上传
      const reusableByKey = new Map<string, UploadRow>();
      for (const row of uploadRows) {
        if (row.status === 'done' && row.result) {
          reusableByKey.set(
            `${row.filename}|${row.sourceUrl}|${row.mediaType}`,
            row,
          );
        }
      }

      const rows: UploadRow[] = files.map((f, i) => {
        const filename = f.filename ?? 'file';
        const sourceUrl = f.url ?? '';
        const mediaType = f.mediaType ?? 'application/octet-stream';
        const reusable = reusableByKey.get(
          `${filename}|${sourceUrl}|${mediaType}`,
        );
        return (
          reusable ?? {
            localId: `up-${Date.now()}-${i}-${filename}`,
            filename,
            mediaType,
            sourceUrl,
            status: 'queued' as const,
          }
        );
      });

      if (rows.some((r) => !r.sourceUrl)) {
        toast.error('附件无效', { description: '缺少文件数据' });
        setUploadRows([]);
        return [];
      }
      setUploadRows(rows);

      for (const row of rows) {
        const meta =
          row.status === 'done' && row.result
            ? row.result
            : await uploadOne(row);
        if (!meta) {
          toast.error('附件上传失败', {
            description: `${row.filename}：可点芯片上的重试，或移除附件后仅发文本`,
          });
          return [];
        }
        uploaded.push(meta);
      }
      return uploaded;
    },
    [uploadOne, uploadRows],
  );

  const contextValue = useMemo<SessionComposerContextValue>(
    () => ({
      actions: {
        applySuggestion,
        cancelEdit,
        dismissUpload,
        prepareFilesForSend,
        resetDraftAfterSend,
        restoreDraft,
        retryUpload,
        setInput,
        startEdit,
      },
      meta: { textareaRef },
      state: { editingMessageId, input, uploadRows },
    }),
    [
      editingMessageId,
      input,
      uploadRows,
      applySuggestion,
      cancelEdit,
      dismissUpload,
      prepareFilesForSend,
      resetDraftAfterSend,
      restoreDraft,
      retryUpload,
      setInput,
      startEdit,
    ],
  );

  return (
    <SessionComposerContext.Provider value={contextValue}>
      {children}
    </SessionComposerContext.Provider>
  );
};

// ============================================================================
// ComposerTextarea - 受控 textarea：读 input/editingMessageId
// ============================================================================

interface ComposerTextareaProps {
  hasPendingInput: boolean;
}

export const ComposerTextarea = memo(function ComposerTextarea({
  hasPendingInput,
}: ComposerTextareaProps) {
  const {
    actions: { setInput },
    meta: { textareaRef },
    state: { input, editingMessageId },
  } = useSessionComposer();

  return (
    <PromptInputTextarea
      ref={textareaRef}
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
      autoFocus={!hasPendingInput}
    />
  );
});

// ============================================================================
// ComposerAttachments - 附件工具条
// ============================================================================

interface ComposerAttachmentsProps {
  hasPendingInput: boolean;
}

export const ComposerAttachments = memo(function ComposerAttachments({
  hasPendingInput,
}: ComposerAttachmentsProps) {
  const attachments = usePromptInputAttachments();
  const {
    actions: { retryUpload, dismissUpload },
    state: { uploadRows },
  } = useSessionComposer();

  const disabled = hasPendingInput || uploadRows.some((r) => r.status === 'uploading');

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

      {uploadRows.length > 0 ? (
        <div
          aria-live="polite"
          aria-relevant="all"
          className="flex max-w-[14rem] flex-wrap gap-1"
          role="status"
        >
          {uploadRows.map((row) => {
            const statusLabel =
              row.status === 'queued'
                ? '排队中'
                : row.status === 'uploading'
                  ? '上传中'
                  : row.status === 'done'
                    ? '上传完成'
                    : `上传失败：${row.error ?? '未知错误'}`;
            return (
              <span
                key={row.localId}
                aria-label={`${row.filename}：${statusLabel}`}
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
                <span aria-hidden className="truncate">
                  {row.filename}
                </span>
                {row.status === 'failed' ? (
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 hover:bg-background"
                    onClick={() => retryUpload(row.localId)}
                    aria-label={`重试 ${row.filename}`}
                  >
                    <RotateCcw className="size-2.5" />
                  </button>
                ) : null}
                {(row.status === 'failed' || row.status === 'done') ? (
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 hover:bg-background"
                    onClick={() => dismissUpload(row.localId)}
                    aria-label={`关闭 ${row.filename}`}
                  >
                    <X className="size-2.5" />
                  </button>
                ) : null}
              </span>
            );
          })}
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
});

// ============================================================================
// ComposerSubmit - 发送按钮
// ============================================================================

interface ComposerSubmitProps {
  sending: boolean;
  hasPendingInput: boolean;
  uploadBusy: boolean;
  onStop: () => void;
}

export function ComposerSubmit({
  sending,
  hasPendingInput,
  uploadBusy,
  onStop,
}: ComposerSubmitProps) {
  const attachments = usePromptInputAttachments();
  const {
    state: { input },
  } = useSessionComposer();
  const hasFiles = attachments.files.length > 0;
  const overMaxLength = getChatMessageLength(input) > MAX_CHAT_MESSAGE_CHARS;
  const textEmpty = !input.trim();
  const submitDisabled = sending
    ? false
    : hasPendingInput || uploadBusy || overMaxLength || (textEmpty && !hasFiles);
  return (
    <PromptInputSubmit
      status={sending ? 'streaming' : 'ready'}
      onStop={onStop}
      disabled={submitDisabled}
    />
  );
}

// ============================================================================
// ComposerLimitHint - 字符数提示
// ============================================================================

export function ComposerLimitHint() {
  const {
    state: { input },
  } = useSessionComposer();
  if (input.length === 0) return null;
  const over = getChatMessageLength(input) > MAX_CHAT_MESSAGE_CHARS;
  return (
    <span
      className={cn(
        'px-1 text-[11px] tabular-nums',
        over ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {getChatMessageLength(input)}/{MAX_CHAT_MESSAGE_CHARS}
    </span>
  );
}

// ============================================================================
// 复用的 handleSubmit 包装：把 composer 提交流程编排到 page 层
// ============================================================================

export interface SendDeps {
  sending: boolean;
  hasPendingInput: boolean;
  editingMessageId: string | null;
  selectedModel: string;
  availableModels: { id: string }[];
  send: (
    content: string,
    opts?: {
      attachments?: Array<{ id: string; filename: string; mediaType: string; size?: number; url?: string }>;
      model?: string;
    },
  ) => Promise<boolean>;
  editResend: (args: {
    messageId: string;
    mode: 'edit' | 'resend' | 'regenerate';
    content?: string;
    model?: string;
  }) => Promise<boolean>;
}

export function useComposerSubmit(deps: SendDeps) {
  const {
    availableModels,
    editResend,
    editingMessageId,
    hasPendingInput,
    selectedModel,
    send,
    sending,
  } = deps;
  const {
    actions: {
      prepareFilesForSend,
      resetDraftAfterSend,
      restoreDraft,
      cancelEdit,
      setInput,
    },
  } = useSessionComposer();

  return useCallback(
    async (message: PromptInputMessage): Promise<void> => {
      const content = message.text ?? '';
      const files = message.files ?? [];
      if (
        sending ||
        hasPendingInput
      ) {
        return;
      }

      // 编辑模式
      if (editingMessageId) {
        if (!content.trim()) return;
        const mid = editingMessageId;
        const draft = content.trim();
        cancelEdit();
        setInput('');
        const ok = await editResend({
          messageId: mid,
          mode: 'edit',
          content: draft,
          ...(availableModels.some((m) => m.id === selectedModel)
            ? { model: selectedModel }
            : {}),
        });
        if (!ok) {
          restoreDraft(draft, mid);
          toast.error('编辑重发失败');
          throw new Error('edit-resend-failed');
        }
        return;
      }

      if (!content.trim() && files.length === 0) return;

      if (files.length === 0) {
        // 文本发送时清掉残留 chips
        resetDraftAfterSend();
      }

      // 上传 + 准备附件
      const uploaded = await prepareFilesForSend(
        files.map((f) => ({
          filename: f.filename,
          mediaType: f.mediaType,
          url: f.url,
        })),
      );
      if (files.length > 0 && uploaded.length === 0) {
        // 上传失败已经在 prepareFilesForSend 里提示过
        throw new Error('attachment-upload-failed');
      }

      // HOOK-004：先清空 UI；send 失败则恢复草稿
      const draftToRestore = content;
      resetDraftAfterSend();
      const ok = await send(content, {
        ...(uploaded.length ? { attachments: uploaded } : {}),
        ...(availableModels.some((m) => m.id === selectedModel)
          ? { model: selectedModel }
          : {}),
      });
      if (!ok) {
        setInput(draftToRestore);
        toast.error('发送失败，草稿已恢复');
        throw new Error('send-failed');
      }
    },
    [
      availableModels,
      cancelEdit,
      editResend,
      editingMessageId,
      hasPendingInput,
      prepareFilesForSend,
      resetDraftAfterSend,
      restoreDraft,
      selectedModel,
      send,
      sending,
      setInput,
    ],
  );
}
