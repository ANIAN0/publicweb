// Tool 分组:连续 dynamic-tool 累积分组 + TOOL_META 摘要 + 长 output 折叠
// COMP-004：头部状态复用 ai-elements Tool/getStatusBadge，自研层只做分组与摘要（DRY）
'use client';

import { useState } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import type { DynamicToolUIPart } from 'ai';
import { cn } from '@/lib/utils';
import {
  Tool,
  ToolContent,
  getStatusBadge,
} from '@/components/ai-elements/tool';
import { CollapsibleTrigger } from '@/components/ui/collapsible';
import { InputRequestActions } from './InputRequestCard';
import { CollapsibleDetail } from './collapsible-detail';
import type { InputResponse, PersistedPart } from '@/lib/protocol/events';
import {
  extractErrorMeta,
  formatToolPayload,
  humanizeToolName,
  inferToolCategory,
  toolIconFor,
  toolInputHint,
} from '@/lib/chat/tool-meta';

// 按 toolCategory 分桶摘要（中文）
function summarizeToolGroup(parts: PersistedPart[]): string {
  if (parts.length === 0) return '';
  const buckets = new Map<'searched' | 'read' | 'wrote' | 'ran', number>();
  let otherCount = 0;
  for (const p of parts) {
    const name = (p as { toolName?: string }).toolName ?? '';
    const cat = inferToolCategory(name);
    if (cat === 'other') otherCount += 1;
    else buckets.set(cat, (buckets.get(cat) ?? 0) + 1);
  }
  if (otherCount > 0 || buckets.size === 0) {
    return `使用了 ${parts.length} 个工具`;
  }
  const verbs: Record<'searched' | 'read' | 'wrote' | 'ran', string> = {
    searched: '搜索',
    read: '读取',
    wrote: '写入',
    ran: '执行',
  };
  const segs: string[] = [];
  for (const key of ['searched', 'read', 'wrote', 'ran'] as const) {
    const n = buckets.get(key);
    if (n) segs.push(`${verbs[key]} ${n} 项`);
  }
  return segs.join(' · ');
}

function hasToolDetails(part: PersistedPart): boolean {
  const p = part as {
    input?: unknown;
    output?: unknown;
    errorText?: string;
    toolMetadata?: { inputRequest?: unknown };
  };
  return Boolean(
    (p.input !== undefined && p.input !== null) ||
      p.output ||
      p.errorText ||
      p.toolMetadata?.inputRequest
  );
}

// 单工具 header：icon + 可读名 + input hint + status + errorMeta
function ToolCallHeader({
  toolName,
  state,
  input,
  errorText,
  output,
}: {
  toolName: string;
  state: DynamicToolUIPart['state'];
  input: unknown;
  errorText?: string;
  output?: unknown;
}) {
  const Icon = toolIconFor(toolName);
  const title = humanizeToolName(toolName);
  const hint = toolInputHint(toolName, input);
  const errMeta = state === 'output-error' ? extractErrorMeta(errorText, output) : undefined;

  return (
    <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 p-3 text-left">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium text-sm">{title}</span>
        {hint && (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={hint}>
            {hint}
          </span>
        )}
        {errMeta && (
          <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-[10px] text-destructive">
            {errMeta}
          </span>
        )}
        {getStatusBadge(state)}
      </div>
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
}

function ToolCallItem({
  part,
  onRespond,
}: {
  part: PersistedPart;
  onRespond?: (r: InputResponse) => void;
}) {
  const p = part as DynamicToolUIPart & { _pid?: string; errorText?: string };
  const meta = (part as { toolMetadata?: { inputRequest?: unknown; inputResponse?: unknown } })
    .toolMetadata;
  const hasInputRequest = Boolean(meta?.inputRequest);
  const hasInputResponse = Boolean(meta?.inputResponse);
  const inputText = formatToolPayload(p.input);
  const outputText = p.errorText
    ? String(p.errorText)
    : formatToolPayload(p.output);

  return (
    <Tool defaultOpen={hasInputRequest} className={cn(p.state === 'output-error' && 'border-destructive/40')}>
      <ToolCallHeader
        toolName={p.toolName}
        state={p.state}
        input={p.input}
        errorText={p.errorText}
        output={p.output}
      />
      <ToolContent>
        {hasInputRequest && onRespond && (
          <InputRequestActions part={part} onRespond={onRespond} canRespond={!hasInputResponse} />
        )}
        {inputText && (
          <div className="space-y-1">
            <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              参数
            </h4>
            <CollapsibleDetail text={inputText} />
          </div>
        )}
        {outputText && (
          <div className="space-y-1">
            <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              {p.errorText ? '错误' : '结果'}
            </h4>
            <CollapsibleDetail
              text={outputText}
              className={p.errorText ? '[&_pre]:bg-destructive/10 [&_pre]:text-destructive' : undefined}
            />
          </div>
        )}
      </ToolContent>
    </Tool>
  );
}

export function ToolGroup({
  parts,
  onRespond,
}: {
  parts: PersistedPart[];
  onRespond?: (r: InputResponse) => void;
}) {
  // HITL 待答时默认展开分组
  const hasPendingHitl = parts.some((part) => {
    const p = part as DynamicToolUIPart & { toolMetadata?: { inputRequest?: unknown; inputResponse?: unknown } };
    return p.state === 'approval-requested' && p.toolMetadata?.inputRequest && !p.toolMetadata?.inputResponse;
  });
  const [open, setOpen] = useState(hasPendingHitl || parts.length === 1);
  if (parts.length === 0) return null;

  const canExpand =
    parts.length > 1 ? parts.some(hasToolDetails) : hasToolDetails(parts[0]);
  const summary = summarizeToolGroup(parts);
  // 单工具且无分组必要：直接渲染一项，避免双层折叠
  if (parts.length === 1) {
    return (
      <div className="mb-4">
        <ToolCallItem part={parts[0]} onRespond={onRespond} />
      </div>
    );
  }

  // 组级首项 icon
  const FirstIcon = toolIconFor((parts[0] as { toolName?: string }).toolName ?? '');

  return (
    <div className="mb-4">
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md border bg-muted/30 p-3 text-sm',
          canExpand ? 'cursor-pointer hover:bg-muted/50' : 'cursor-default opacity-80'
        )}
      >
        <FirstIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium">{summary}</span>
        {canExpand && (
          <ChevronDownIcon
            className={cn(
              'ml-auto size-4 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180'
            )}
          />
        )}
      </button>
      {open && canExpand && (
        <div className="mt-2 space-y-2">
          {parts.map((p, i) => (
            <ToolCallItem key={(p as { _pid?: string })._pid ?? i} part={p} onRespond={onRespond} />
          ))}
        </div>
      )}
    </div>
  );
}
