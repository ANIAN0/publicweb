// Tool 分组:连续 dynamic-tool 累积分组,摘要行按 toolCategory 分桶输出"Verb N things"
// 对齐 eve-chat-template message.tsx:357-429,752-855 ToolGroup
'use client';

import { useState } from 'react';
import { ChevronDownIcon, WrenchIcon } from 'lucide-react';
import type { DynamicToolUIPart } from 'ai';
import { cn } from '@/lib/utils';
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { InputRequestActions } from './InputRequestCard';
import type { InputResponse, PersistedPart } from '@/lib/protocol/events';

// toolCategory 从 toolName 推断(对齐 template toolCategory 推断规则)
// searched:grep/search/find/glob;read:read/cat/head/tail/view;wrote:write/edit/patch/append/create;ran:bash/run/exec
function inferToolCategory(toolName: string): 'searched' | 'read' | 'wrote' | 'ran' | 'other' {
  const n = toolName.toLowerCase();
  if (/grep|search|find|glob/.test(n)) return 'searched';
  if (/^read|^cat|^head|^tail|view/.test(n)) return 'read';
  if (/write|edit|patch|append|create|mkdir|^rm$|^mv$/.test(n)) return 'wrote';
  if (/bash|run|exec|^sh$/.test(n)) return 'ran';
  return 'other';
}

// 按 toolCategory 分桶输出摘要行(对齐 template summarizeToolGroup)
// searched→"Searched N things" / read→"Read N things" / wrote→"Wrote N things" / ran→"Ran N things"
// 多桶用 · 连接;全 other 或有 other 混合 → "Used N tools"(兜底,对齐 template)
function summarizeToolGroup(parts: PersistedPart[]): string {
  if (parts.length === 0) return '';
  const buckets = new Map<'searched' | 'read' | 'wrote' | 'ran', number>();
  let otherCount = 0;
  for (const p of parts) {
    const name = (p as { toolName?: string }).toolName ?? '';
    const cat = inferToolCategory(name);
    if (cat === 'other') {
      otherCount += 1;
    } else {
      buckets.set(cat, (buckets.get(cat) ?? 0) + 1);
    }
  }
  // 全 other 或有 other 混合 → "Used N tools"
  if (otherCount > 0 || buckets.size === 0) {
    return `Used ${parts.length} ${parts.length === 1 ? 'tool' : 'tools'}`;
  }
  const verbs: Record<'searched' | 'read' | 'wrote' | 'ran', string> = {
    searched: 'Searched',
    read: 'Read',
    wrote: 'Wrote',
    ran: 'Ran',
  };
  const segs: string[] = [];
  for (const key of ['searched', 'read', 'wrote', 'ran'] as const) {
    const n = buckets.get(key);
    if (n) segs.push(`${verbs[key]} ${n} ${n === 1 ? 'thing' : 'things'}`);
  }
  return segs.join(' · ');
}

// part 是否有可展开详情(input/output/errorText/inputRequest)
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

// 单个 Tool 调用项:复用 Tool 折叠 + ToolContent 内 InputRequestActions(T-008)+ ToolInput/ToolOutput
function ToolCallItem({
  part,
  onRespond,
}: {
  part: PersistedPart;
  onRespond?: (r: InputResponse) => void;
}) {
  // part 是 dynamic-tool PersistedPart;断言为 DynamicToolUIPart + _pid 访问标准字段
  const p = part as DynamicToolUIPart & { _pid?: string };
  // eve toolMetadata 非标准字段,单独断言(inputRequest/inputResponse 由 eveagent.ts + respondInput 注入)
  // toolMetadata 统一路径（去 eve 专用）：inputRequest/inputResponse 由 adapter 注入
  const meta = (part as { toolMetadata?: { inputRequest?: unknown; inputResponse?: unknown } }).toolMetadata;
  const hasInputRequest = Boolean(meta?.inputRequest);
  const hasInputResponse = Boolean(meta?.inputResponse);
  return (
    <Tool defaultOpen={hasInputRequest}>
      <ToolHeader type="dynamic-tool" state={p.state} toolName={p.toolName} />
      <ToolContent>
        {/* HITL 问题嵌顶部(与 ToolInput/ToolOutput 同级,T-008 嵌入式) */}
        {hasInputRequest && onRespond && (
          <InputRequestActions part={part} onRespond={onRespond} canRespond={!hasInputResponse} />
        )}
        <ToolInput input={p.input} />
        <ToolOutput output={p.output} errorText={p.errorText} />
      </ToolContent>
    </Tool>
  );
}

// ToolGroup:连续 dynamic-tool 分组,摘要行可展开/收起
export function ToolGroup({
  parts,
  onRespond,
}: {
  parts: PersistedPart[];
  onRespond?: (r: InputResponse) => void;
}) {
  const [open, setOpen] = useState(false);
  if (parts.length === 0) return null;
  // canExpand:多 tool 时 some(hasToolDetails);单 tool 时 hasToolDetails(parts[0])(单 tool 有 details 也可展开)
  const canExpand =
    parts.length > 1 ? parts.some(hasToolDetails) : hasToolDetails(parts[0]);
  const summary = summarizeToolGroup(parts);
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
        <WrenchIcon className="size-4 text-muted-foreground" />
        <span className="font-medium">{summary}</span>
        {canExpand && (
          <ChevronDownIcon
            className={cn(
              'ml-auto size-4 text-muted-foreground transition-transform',
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
