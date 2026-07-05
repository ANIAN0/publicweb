'use client';

// 工具调用卡片：折叠/展开 + tool name + input + output
// 用于单会话页消息流中渲染 tool.call / tool.result
import { useState } from 'react';

export interface ToolCallCardProps {
  toolName: string;
  input: unknown;
  output?: string;
  isError?: boolean;
  // 默认折叠
  defaultCollapsed?: boolean;
}

export function ToolCallCard({ toolName, input, output, isError, defaultCollapsed = true }: ToolCallCardProps) {
  const [open, setOpen] = useState(!defaultCollapsed);
  const inputStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2);

  return (
    <div className="my-2 border border-zinc-300 dark:border-zinc-700 rounded-lg overflow-hidden text-sm">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700"
      >
        <span className="font-mono">
          {isError ? '✗' : '⚙'} {toolName}
        </span>
        <span className="text-zinc-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-3 py-2 space-y-2">
          <div>
            <div className="text-xs text-zinc-500 mb-1">input</div>
            <pre className="bg-zinc-50 dark:bg-zinc-900 p-2 rounded overflow-x-auto text-xs">{inputStr}</pre>
          </div>
          {output !== undefined && (
            <div>
              <div className="text-xs text-zinc-500 mb-1">output{isError ? ' (error)' : ''}</div>
              <pre className={`p-2 rounded overflow-x-auto text-xs ${isError ? 'bg-red-50 dark:bg-red-950' : 'bg-zinc-50 dark:bg-zinc-900'}`}>
                {output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
