// useStreamingText:流式文本分步 reveal(60ms tick),防 React 重渲染跳变
// 对齐 eve-chat-template message.tsx:200-263 useStreamingText
'use client';

import { useEffect, useRef, useState } from 'react';

// 已显示文本缓存(跨 hook 实例,防 part 重渲染从头跳变——part 重渲染时从缓存恢复已显示长度)
const streamingTextCache = new Map<string, string>();

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
    // 文本被校正(新 text 不以 current 开头)→ 直接显示完整新文本(对齐 template startsWith 检测)
    if (!text.startsWith(current)) {
      currentRef.current = text;
      setDisplayText(text);
      if (cacheKey) streamingTextCache.set(cacheKey, text);
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
      if (cacheKey) streamingTextCache.set(cacheKey, next);
    }, 60);

    return () => clearInterval(tick);
  }, [text, cacheKey]);

  return displayText;
}
