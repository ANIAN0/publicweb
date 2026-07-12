// useStreamingText:流式文本分步 reveal(60ms tick),防 React 重渲染跳变
// 对齐 eve-chat-template message.tsx:200-263 useStreamingText
'use client';

import { useEffect, useRef, useState } from 'react';

// 已显示文本缓存(跨 hook 实例,防 part 重渲染从头跳变——part 重渲染时从缓存恢复已显示长度)
// HOOK-001：LRU 淘汰，上限 50，避免长会话无限增长
const MAX_STREAMING_CACHE = 50;
const streamingTextCache = new Map<string, string>();

/** 写入缓存；命中时挪到末尾，超出上限淘汰最旧条目 */
function cacheSet(key: string, value: string): void {
  if (streamingTextCache.has(key)) streamingTextCache.delete(key);
  streamingTextCache.set(key, value);
  while (streamingTextCache.size > MAX_STREAMING_CACHE) {
    const oldest = streamingTextCache.keys().next().value;
    if (oldest === undefined) break;
    streamingTextCache.delete(oldest);
  }
}

// 分步 reveal 步长:按 remaining 文本长度递减(对齐 template)
// >160→6 / >80→5 / >32→3 / >12→2 / 否则1
function stepSize(remaining: number): number {
  if (remaining > 160) return 6;
  if (remaining > 80) return 5;
  if (remaining > 32) return 3;
  if (remaining > 12) return 2;
  return 1;
}

export function useStreamingText(text: string, cacheKey?: string): string {
  const [displayText, setDisplayText] = useState<string>(() => {
    // 从缓存恢复(防重渲染从头跳变)
    if (cacheKey && streamingTextCache.has(cacheKey)) {
      return streamingTextCache.get(cacheKey)!;
    }
    return text;
  });
  const currentRef = useRef(displayText);

  useEffect(() => {
    const current = currentRef.current;
    // HOOK-005：校正策略——仅当 current 非空且不是 text 前缀时整段替换
    // （空 current 或 text 仍以 current 为前缀 → 走 reveal；避免 startsWith 误判无关）
    if (current.length > 0 && !text.startsWith(current)) {
      // 若新文本包含已显示内容为子串（中段校正），仍整段跳到最终 text
      currentRef.current = text;
      setDisplayText(text);
      if (cacheKey) cacheSet(cacheKey, text);
      return;
    }
    // 已显示完整 → 无需 tick
    if (current === text) return;

    // 60ms tick 分步 reveal(对齐 template;catchUp 加速靠 stepSize 按 remaining 递增步长)
    const tick = setInterval(() => {
      const cur = currentRef.current;
      if (cur === text) {
        clearInterval(tick);
        return;
      }
      const remaining = text.length - cur.length;
      const step = stepSize(remaining);
      const next = text.slice(0, cur.length + step);
      currentRef.current = next;
      setDisplayText(next);
      if (cacheKey) cacheSet(cacheKey, next);
    }, 60);

    return () => clearInterval(tick);
  }, [text, cacheKey]);

  return displayText;
}
