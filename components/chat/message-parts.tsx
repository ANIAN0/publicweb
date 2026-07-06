// UIMessage.parts 渲染分发器:按 part.type 分发到 ai-elements 子组件
// text→Streamdown(markdown), reasoning→Reasoning(折叠), dynamic-tool→ToolGroup(连续累积分组,T-009)
// 其他 part(file/data-*/source-* 等):协议层已支持,渲染层后续完善,暂简单 JSON 展示避免内容丢失
'use client';

import { Streamdown } from 'streamdown';
import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import type { ReactNode } from 'react';
import type { UIMessagePart } from 'ai';
import type { InputResponse, PersistedPart } from '@/lib/protocol/events';
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning';
import { ToolGroup } from './tool-group';
import { useStreamingText } from '@/hooks/use-streaming-text';

// Streamdown 插件:中文优化 + 代码高亮 + 数学公式 + mermaid 图(与 ai-elements 内部一致)
const streamdownPlugins = { cjk, code, math, mermaid };

// AssistantTextPart:text part 用 useStreamingText 分步 reveal 喂 Streamdown(T-010 流式平滑)
function AssistantTextPart({ text, cacheKey }: { text: string; cacheKey?: string }) {
  const displayText = useStreamingText(text, cacheKey);
  return <Streamdown plugins={streamdownPlugins}>{displayText}</Streamdown>;
}

// 渲染非 dynamic-tool part(text/reasoning/default)
function renderPart(part: UIMessagePart<any, any>, key: number): ReactNode {
  switch (part.type) {
    case 'text':
      // 文本:useStreamingText 分步 reveal 喂 Streamdown(含 code/math/mermaid,T-010 流式平滑)
      return <AssistantTextPart key={key} text={part.text} cacheKey={(part as PersistedPart)._pid} />
    case 'reasoning':
      // 思考:折叠展示;state=streaming 时自动展开 + Shimmer "Thinking..."
      return (
        <Reasoning key={key} isStreaming={part.state === 'streaming'}>
          <ReasoningTrigger />
          {/* ReasoningContent 内部用 Streamdown 渲染 children(string) */}
          <ReasoningContent>{part.text}</ReasoningContent>
        </Reasoning>
      );
    default:
      // 其他 part(file/data-*/source-* 等):TODO 后续按 type 接 Image/Commit/PR/Snippet 等组件
      // 暂简单 JSON 展示,避免内容丢失(非降级:协议层已支持完整 part,渲染逐步完善)
      return (
        <pre
          key={key}
          className="overflow-x-auto rounded-md bg-muted/50 p-2 text-xs text-muted-foreground"
        >
          {JSON.stringify(part, null, 2)}
        </pre>
      );
  }
}

export function MessageParts({
  parts,
  onRespond,
}: {
  parts: UIMessagePart<any, any>[];
  // HITL 回答回调:ToolGroup 内 dynamic-tool part 的 InputRequestActions 用它提交回答(eve ask_question / approval)
  onRespond?: (response: InputResponse) => void;
}) {
  // 累积连续 dynamic-tool 到 pendingTools,遇非 dynamic-tool 时 flushTools 渲染 ToolGroup(T-009 分组)
  const out: ReactNode[] = [];
  let pendingTools: PersistedPart[] = [];
  let groupIdx = 0;
  const flushTools = () => {
    if (pendingTools.length === 0) return;
    const tools = pendingTools;
    pendingTools = [];
    out.push(<ToolGroup key={`tg-${groupIdx++}`} parts={tools} onRespond={onRespond} />);
  };
  parts.forEach((part, i) => {
    if (part.type === 'dynamic-tool') {
      pendingTools.push(part as PersistedPart);
    } else {
      flushTools();
      out.push(renderPart(part, i));
    }
  });
  flushTools();
  return <>{out}</>;
}
