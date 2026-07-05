// UIMessage.parts 渲染分发器:按 part.type 分发到 ai-elements 子组件
// text→Streamdown(markdown), reasoning→Reasoning(折叠), dynamic-tool→Tool(折叠+状态 badge)
// 其他 part(file/data-*/source-* 等):协议层已支持,渲染层后续完善,暂简单 JSON 展示避免内容丢失
'use client';

import { Streamdown } from 'streamdown';
import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import type { UIMessagePart } from 'ai';
import type { InputResponse, PersistedPart } from '@/lib/protocol/events';
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { InputRequestCard } from './InputRequestCard';

// Streamdown 插件:中文优化 + 代码高亮 + 数学公式 + mermaid 图(与 ai-elements 内部一致)
const streamdownPlugins = { cjk, code, math, mermaid };

export function MessageParts({
  parts,
  onRespond,
}: {
  parts: UIMessagePart<any, any>[];
  // HITL 回答回调:有 inputRequest 的 dynamic-tool part 用它提交回答(eve ask_question / approval)
  onRespond?: (response: InputResponse) => void;
}) {
  return (
    <>
      {parts.map((part, i) => {
        // 按 part.type 分发到对应 ai-elements 子组件(类型 narrowing 后访问各 part 的字段)
        switch (part.type) {
          case 'text':
            // 文本:Streamdown 渲染 markdown(含 code/math/mermaid)
            return (
              <Streamdown key={i} plugins={streamdownPlugins}>
                {part.text}
              </Streamdown>
            );
          case 'reasoning':
            // 思考:折叠展示;state=streaming 时自动展开 + Shimmer "Thinking..."
            return (
              <Reasoning key={i} isStreaming={part.state === 'streaming'}>
                <ReasoningTrigger />
                {/* ReasoningContent 内部用 Streamdown 渲染 children(string) */}
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            );
          case 'dynamic-tool': {
            // 有 inputRequest → HITL 问题卡片(eve ask_question / tool-approval),不走普通 Tool 折叠
            const inputRequest = (part as { toolMetadata?: { eve?: { inputRequest?: unknown } } })
              .toolMetadata?.eve?.inputRequest;
            if (inputRequest && onRespond) {
              return (
                <InputRequestCard
                  key={i}
                  part={part as PersistedPart}
                  onRespond={onRespond}
                />
              );
            }
            // 普通工具调用:折叠展示,header 显示工具名 + 状态 badge,content 显示 input/output
            return (
              <Tool key={i}>
                <ToolHeader
                  type={part.type}
                  state={part.state}
                  toolName={part.toolName}
                />
                <ToolContent>
                  <ToolInput input={part.input} />
                  {/* output/errorText 在 output-available/output-error 状态才有值 */}
                  <ToolOutput output={part.output} errorText={part.errorText} />
                </ToolContent>
              </Tool>
            );
          }
          default:
            // 其他 part(file/data-*/source-* 等):TODO 后续按 type 接 Image/Commit/PR/Snippet 等组件
            // 暂简单 JSON 展示,避免内容丢失(非降级:协议层已支持完整 part,渲染逐步完善)
            return (
              <pre
                key={i}
                className="overflow-x-auto rounded-md bg-muted/50 p-2 text-xs text-muted-foreground"
              >
                {JSON.stringify(part, null, 2)}
              </pre>
            );
        }
      })}
    </>
  );
}
