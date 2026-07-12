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
// cacheKey 须含 message 作用域，避免跨消息复用同一 _pid 时 reveal 缓存串台（DIAG-006）
function AssistantTextPart({ text, cacheKey }: { text: string; cacheKey?: string }) {
  const displayText = useStreamingText(text, cacheKey);
  return <Streamdown plugins={streamdownPlugins}>{displayText}</Streamdown>;
}

// COMP-012：file part 字段窄化，避免散落 as
type FilePartFields = {
  filename?: string;
  mediaType?: string;
  url?: string;
};

type NormalizedFilePartFields = {
  filename: string;
  mediaType: string;
  url: string;
};

function asFileFields(part: UIMessagePart<any, any>): NormalizedFilePartFields {
  const p = part as FilePartFields;
  return {
    filename: typeof p.filename === 'string' ? p.filename : 'file',
    mediaType: typeof p.mediaType === 'string' ? p.mediaType : '',
    url: typeof p.url === 'string' ? p.url : '',
  };
}

// 用户/助手 file part：图片内联预览，其它类型可点击下载
function FilePartView({ part, keyId }: { part: UIMessagePart<any, any>; keyId: number | string }) {
  const { filename, mediaType, url } = asFileFields(part);
  if (mediaType.startsWith('image/') && url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- 会话附件 URL 动态
      <img
        key={keyId}
        src={url}
        alt={filename}
        className="my-1 max-h-64 max-w-full rounded-md border border-border object-contain"
      />
    );
  }
  return (
    <a
      key={keyId}
      href={url || undefined}
      target="_blank"
      rel="noreferrer"
      className="my-1 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-foreground hover:bg-muted"
    >
      <span className="truncate font-medium">{filename}</span>
      {mediaType ? <span className="shrink-0 text-muted-foreground">{mediaType}</span> : null}
    </a>
  );
}

// 渲染非 dynamic-tool / 非 text 缓冲 part(reasoning/file/default)
function renderPart(
  part: UIMessagePart<any, any>,
  key: number,
  messageId?: string,
): ReactNode {
  switch (part.type) {
    case 'text': {
      // 文本:useStreamingText 分步 reveal 喂 Streamdown(含 code/math/mermaid,T-010 流式平滑)
      const pid = (part as PersistedPart)._pid;
      const cacheKey = messageId && pid ? `${messageId}:${pid}` : pid;
      return <AssistantTextPart key={key} text={part.text} cacheKey={cacheKey} />;
    }
    case 'reasoning': {
      // 思考:折叠展示;state=streaming 时自动展开 + Shimmer「思考中…」
      const text = typeof part.text === 'string' ? part.text : '';
      const streaming = part.state === 'streaming';
      // 空内容且非流式 → 不渲染,避免留下点不开的假入口(DIAG-005;流式期即使暂空仍显示「思考中」)
      if (!streaming && !text.trim()) return null;
      return (
        <Reasoning key={key} isStreaming={streaming}>
          <ReasoningTrigger />
          {/* ReasoningContent 内部用 Streamdown 渲染 children(string) */}
          <ReasoningContent>{text}</ReasoningContent>
        </Reasoning>
      );
    }
    case 'file':
      return <FilePartView key={key} part={part} keyId={key} />;
    default:
      // 其他 part(data-*/source-* 等):TODO 后续按 type 接 Image/Commit/PR/Snippet 等组件
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
  messageId,
  onRespond,
}: {
  parts: UIMessagePart<any, any>[];
  /** 用于 streaming cacheKey 作用域隔离（DIAG-006） */
  messageId?: string;
  // HITL 回答回调:ToolGroup 内 dynamic-tool part 的 InputRequestActions 用它提交回答(eve ask_question / approval)
  onRespond?: (response: InputResponse) => void;
}) {
  // 双缓冲：连续 dynamic-tool → ToolGroup；连续 text → 拼成一块（避免碎气泡）
  const out: ReactNode[] = [];
  let pendingTools: PersistedPart[] = [];
  let pendingTexts: PersistedPart[] = [];
  let groupIdx = 0;
  let textIdx = 0;

  const flushTools = () => {
    if (pendingTools.length === 0) return;
    const tools = pendingTools;
    pendingTools = [];
    out.push(<ToolGroup key={`tg-${groupIdx++}`} parts={tools} onRespond={onRespond} />);
  };

  // 相邻 text part 合并：语义上是同一段话，中间未被 tool/reasoning 打断
  // COMP-005：用双换行保留段落边界（单段内流式 delta 仍是同一 part，不经此 join）
  const flushTexts = () => {
    if (pendingTexts.length === 0) return;
    const texts = pendingTexts;
    pendingTexts = [];
    const merged = texts
      .map((p) => {
        const t = (p as PersistedPart & { text?: unknown }).text;
        return typeof t === 'string' ? t : '';
      })
      .join('\n\n');
    const firstPid = texts[0]?._pid;
    const joinedPids = texts.map((p) => p._pid).filter(Boolean).join('+');
    const rawKey = firstPid || joinedPids || `txt-${textIdx}`;
    // messageId 作用域：禁止跨 assistant 消息复用同一 _pid 时 reveal 缓存串台
    const cacheKey = messageId ? `${messageId}:${rawKey}` : rawKey;
    out.push(<AssistantTextPart key={`tx-${textIdx++}`} text={merged} cacheKey={cacheKey} />);
  };

  parts.forEach((part, i) => {
    if (part.type === 'dynamic-tool') {
      flushTexts();
      pendingTools.push(part as PersistedPart);
      return;
    }
    if (part.type === 'text') {
      flushTools();
      pendingTexts.push(part as PersistedPart);
      return;
    }
    // file / reasoning / 其他：打断 text 与 tool 缓冲
    flushTools();
    flushTexts();
    out.push(renderPart(part, i, messageId));
  });
  flushTools();
  flushTexts();
  return <>{out}</>;
}
