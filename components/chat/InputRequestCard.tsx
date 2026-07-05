// HITL 问题卡片:渲染 eve input.requested 的 inputRequest(对齐 eve 官方模板 agent-message.tsx)
// display 三态:confirmation(approve/deny)/ select(选项按钮)/ text(自由输入) + allowFreeform(选项外自定义文本)
// 已回答(inputResponse 存在)时只读展示;待回答时按 display 渲染交互,提交回调 onRespond
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { InputResponse, PersistedPart } from '@/lib/protocol/events';

// eve inputRequest 的 UI 可见字段(对齐 eve EveMessageInputRequest,见 eve/client/message-reducer-types.ts:228)
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

interface InputRequestCardProps {
  part: PersistedPart;
  onRespond: (response: InputResponse) => void;
  disabled?: boolean;
}

export function InputRequestCard({ part, onRespond, disabled }: InputRequestCardProps) {
  // toolMetadata.eve.inputRequest 由 eveagent.ts 的 input.requested 映射注入
  const meta = (part as {
    toolMetadata?: { eve?: { inputRequest?: InputRequest; inputResponse?: InputResponse } };
  }).toolMetadata;
  const inputRequest = meta?.eve?.inputRequest;
  const inputResponse = meta?.eve?.inputResponse;
  if (!inputRequest) return null;

  const { requestId, prompt, display, options, allowFreeform } = inputRequest;
  // text 类型:display==='text' 或无 options(纯自由文本题)
  const isText = display === 'text' || !options || options.length === 0;
  const [text, setText] = useState('');

  // 已回答:只读展示用户的选择/文本(乐观 inputResponse 或服务端 action.result 后保留)
  if (inputResponse) {
    const selected = options?.find((o) => o.id === inputResponse.optionId);
    const answerLabel = selected?.label ?? inputResponse.text ?? inputResponse.optionId ?? '已回答';
    return (
      <div className="space-y-2 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3">
        <p className="text-sm text-muted-foreground">{prompt}</p>
        <p className="text-sm font-medium">已回答：{answerLabel}</p>
      </div>
    );
  }

  // 待回答:提交选项(optionId)或自由文本(text)
  const submitOption = (optionId: string) => {
    if (disabled) return;
    onRespond({ requestId, optionId });
  };
  const submitText = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onRespond({ requestId, text: t });
    setText('');
  };

  return (
    <div className="space-y-3 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3">
      <p className="text-sm text-muted-foreground">{prompt}</p>

      {/* confirmation / select:选项按钮组(对齐 eve 模板,danger style → destructive variant) */}
      {!isText && options && options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option.id}
              disabled={disabled}
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

      {/* text 类型 或 allowFreeform:自由文本输入框(补 eve 模板缺口:模板未实现 text/allowFreeform) */}
      {(isText || allowFreeform) && (
        <div className="flex flex-col gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={disabled}
            placeholder={isText ? '输入回答…' : '或输入自定义回答…'}
            className="min-h-16 w-full resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onKeyDown={(e) => {
              // Enter 提交,Shift+Enter 换行
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitText();
              }
            }}
          />
          <Button onClick={submitText} disabled={disabled || !text.trim()} size="sm" className="self-end">
            提交
          </Button>
        </div>
      )}
    </div>
  );
}
