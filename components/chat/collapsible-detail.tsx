// 工具 input/output 长内容折叠：默认截断，一键展开
// 对标 DEEIX TOOL_DETAIL_COLLAPSED_LINES=8 / 420 chars
'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  shouldCollapseToolDetail,
  TOOL_DETAIL_COLLAPSE_LINES,
} from '@/lib/chat/tool-meta';

export function CollapsibleDetail({
  text,
  className,
  mono = true,
}: {
  text: string;
  className?: string;
  mono?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const needsCollapse = shouldCollapseToolDetail(text);
  // 折叠态只显示前 N 行
  const display =
    needsCollapse && !expanded
      ? text
          .split(/\r?\n/)
          .slice(0, TOOL_DETAIL_COLLAPSE_LINES)
          .join('\n') + (text.includes('\n') ? '\n…' : '…')
      : text;

  return (
    <div className={cn('relative', className)}>
      <pre
        className={cn(
          'overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 text-xs text-foreground',
          mono && 'font-mono'
        )}
      >
        {display}
      </pre>
      {needsCollapse && (
        <div className="mt-1 flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-6 gap-1 text-[11px] text-muted-foreground"
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronDown
              className={cn('size-3 transition-transform', expanded && 'rotate-180')}
            />
            {expanded ? '收起' : '展开全部'}
          </Button>
        </div>
      )}
    </div>
  );
}
