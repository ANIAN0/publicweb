// HITL 嵌入式回答组件:嵌在 ToolContent 内顶部,与 ToolInput/ToolOutput 同级(D-003 嵌入 Tool 不保留独立卡片)
// 无三态分支统一渲染:有 options 显按钮组 + (allowFreeform||text||无options) 显输入框;已回答只读
// 对齐 eve-chat-template message.tsx:582-674 InputRequestActions
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { InputResponse, PersistedPart } from '@/lib/protocol/events';

// eve inputRequest 的 UI 可见字段(对齐 eve EveMessageInputRequest,见 eve/client/message-reducer-types.ts)
interface InputRequest {
  requestId: string;
  prompt: string;
  display?: 'confirmation' | 'select' | 'text';
  options?: ReadonlyArray<{
    id: string;
    label: string;
    description?: string;
    style?: 'danger' | 'default' | 'primary';
  }>;
  allowFreeform?: boolean;
}

interface InputRequestActionsProps {
  part: PersistedPart;
  onRespond: (response: InputResponse) => void;
  // 是否可回答:已回答(inputResponse 存在)时 false → 控件禁用;由 message-parts 传 !inputResponse
  canRespond?: boolean;
}

export function InputRequestActions({ part, onRespond, canRespond = true }: InputRequestActionsProps) {
  // toolMetadata.eve.inputRequest/inputResponse:由 eveagent.ts input.requested 映射注入 + respondInput 乐观更新挂上
  const meta = (part as {
    toolMetadata?: { eve?: { inputRequest?: InputRequest; inputResponse?: InputResponse } };
  }).toolMetadata;
  const inputRequest = meta?.eve?.inputRequest;
  const inputResponse = meta?.eve?.inputResponse;
  // 无 inputRequest(普通工具调用)不渲染
  if (!inputRequest) return null;

  const { requestId, prompt, display, options, allowFreeform } = inputRequest;
  const [text, setText] = useState('');

  // 已回答(只读):展示用户的选择/文本(inputResponse 由 respondInput 乐观挂上或服务端 action.result 保留)
  if (inputResponse) {
    const selected = options?.find((o) => o.id === inputResponse.optionId);
    const answerLabel = selected?.label ?? inputResponse.text ?? inputResponse.optionId ?? '已回答';
    return (
      <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
        <p className="text-sm text-muted-foreground">{prompt}</p>
        <p className="text-sm font-medium">已回答：{answerLabel}</p>
      </div>
    );
  }

  // 待回答:统一渲染(无三态分支)
  // 有 options → 按钮组(danger style → destructive variant 红色)
  // allowFreeform || display==='text' || 无 options → 输入框 + 提交(Enter)
  const submitOption = (optionId: string) => {
    if (!canRespond) return;
    onRespond({ requestId, optionId });
  };
  const submitText = () => {
    const t = text.trim();
    if (!t || !canRespond) return;
    onRespond({ requestId, text: t });
    setText('');
  };
  const showInput = allowFreeform || display === 'text' || !options || options.length === 0;

  return (
    <div className="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
      <p className="text-sm text-muted-foreground">{prompt}</p>
      {/* 选项按钮组(confirmation/select);danger style → destructive variant(红色) */}
      {options && options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option.id}
              disabled={!canRespond}
              onClick={() => submitOption(option.id)}
              variant={option.style === 'danger' ? 'destructive' : 'default'}
              size="sm"
              title={option.description}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}
      {/* 自由文本输入(text 类型 / allowFreeform / 无 options) */}
      {showInput && (
        <div className="flex flex-col gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!canRespond}
            placeholder={display === 'text' || !options ? '输入回答…' : '或输入自定义回答…'}
            className="min-h-16 w-full resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onKeyDown={(e) => {
              // Enter 提交,Shift+Enter 换行
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitText();
              }
            }}
          />
          <Button onClick={submitText} disabled={!canRespond || !text.trim()} size="sm" className="self-end">
            提交
          </Button>
        </div>
      )}
    </div>
  );
}
