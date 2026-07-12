// 消息元信息栏：相对时间 + hover 操作（复制 / 编辑 / 重发 / 再生成 / 分支）
// 交互对标 DEEIX-Chat message-meta：桌面 hover/focus-within 显操作，触屏常显
'use client';

import { useCallback, useState } from 'react';
import {
  Check,
  Copy,
  GitFork,
  Pencil,
  RotateCcw,
} from 'lucide-react';
import { toast } from 'sonner';
import { MessageAction, MessageActions } from '@/components/ai-elements/message';
import { TooltipProvider } from '@/components/ui/tooltip';
import { formatPartsForExport } from '@/lib/chat/parts';
import { cn } from '@/lib/utils';
import { formatRelative } from '@/lib/utils';

export interface MessageMetaProps {
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt?: string | Date | null;
  className?: string;
  /** 是否允许编辑/重发等（发送中禁用） */
  actionsDisabled?: boolean;
  onEdit?: () => void;
  onResend?: () => void;
  onRegenerate?: () => void;
  onFork?: () => void;
}

// 从 UIMessage.parts 抽可复制纯文本：含 text + reasoning（思考过程），省略 tool。
// agent history 仍走 extractTextFromParts（text-only）；此处是用户「可查看」导出路径（D-R05 / DIAG-005）。
export function extractMessagePlainText(
  parts: ReadonlyArray<{ type: string; text?: string }>
): string {
  return formatPartsForExport(parts);
}

// COMP-006：hover/触屏可见性 class 抽常量，避免模板内重复长串
const META_VISIBILITY_CLASS =
  'opacity-100 transition-opacity duration-150 md:pointer-events-none md:opacity-0 md:group-hover:pointer-events-auto md:group-hover:opacity-100 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100 [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100';

export function MessageMeta({
  role,
  text,
  createdAt,
  className,
  actionsDisabled,
  onEdit,
  onResend,
  onRegenerate,
  onFork,
}: MessageMetaProps) {
  const [copied, setCopied] = useState(false);
  const alignEnd = role === 'user';
  const hasText = text.length > 0;

  const handleCopy = useCallback(async () => {
    if (!hasText) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success('已复制到剪贴板');
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('复制失败，请检查剪贴板权限');
    }
  }, [hasText, text]);

  const hasActions =
    hasText ||
    onEdit ||
    onResend ||
    onRegenerate ||
    onFork ||
    createdAt != null;
  if (!hasActions) return null;

  return (
    <div
      className={cn(
        'mt-1 flex items-center gap-1 text-xs text-muted-foreground',
        META_VISIBILITY_CLASS,
        alignEnd ? 'justify-end' : 'justify-start',
        className,
      )}
    >
      {createdAt != null && (
        <span className="inline-flex h-6 shrink-0 items-center tabular-nums" title={String(createdAt)}>
          {formatRelative(createdAt)}
        </span>
      )}
      {/* COMP-010：每条消息一层 Provider，Action 内不再各自包 */}
      <TooltipProvider>
        <MessageActions>
          {hasText && (
            <MessageAction
              tooltip={copied ? '已复制' : '复制'}
              label={copied ? '已复制' : '复制消息'}
              onClick={() => void handleCopy()}
            >
              {copied ? (
                <Check className="size-3.5 text-success" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </MessageAction>
          )}
          {role === 'user' && onEdit && (
            <MessageAction
              tooltip="编辑并重发"
              label="编辑消息"
              disabled={actionsDisabled}
              onClick={onEdit}
            >
              <Pencil className="size-3.5" />
            </MessageAction>
          )}
          {role === 'user' && onResend && (
            <MessageAction
              tooltip="重发"
              label="重发消息"
              disabled={actionsDisabled}
              onClick={onResend}
            >
              <RotateCcw className="size-3.5" />
            </MessageAction>
          )}
          {role === 'assistant' && onRegenerate && (
            <MessageAction
              tooltip="再生成"
              label="再生成回复"
              disabled={actionsDisabled}
              onClick={onRegenerate}
            >
              <RotateCcw className="size-3.5" />
            </MessageAction>
          )}
          {(role === 'user' || role === 'assistant') && onFork && (
            <MessageAction
              tooltip="从此处分支"
              label="分支会话"
              disabled={actionsDisabled}
              onClick={onFork}
            >
              <GitFork className="size-3.5" />
            </MessageAction>
          )}
        </MessageActions>
      </TooltipProvider>
    </div>
  );
}
