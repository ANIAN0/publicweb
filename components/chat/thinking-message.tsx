// ThinkingMessage:busy 无可见 part 时的占位反馈(aria-live + shimmer "Thinking...")
// 对齐 eve-chat-template agent-chat.tsx:2014-2029 ThinkingMessage + useThinkingPresence(180ms 淡出)
'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Shimmer } from '@/components/ai-elements/shimmer';

// useThinkingPresence:show 变 false 时 180ms 后隐藏(防闪烁,对齐 template 180ms 淡出)
function useThinkingPresence(show: boolean): boolean {
  const [visible, setVisible] = useState(show);
  useEffect(() => {
    if (show) {
      setVisible(true);
    } else {
      // 180ms 后隐藏(淡出动画时间)
      const t = setTimeout(() => setVisible(false), 180);
      return () => clearTimeout(t);
    }
  }, [show]);
  return visible;
}

export function ThinkingMessage({ show }: { show: boolean }) {
  // show 变 false 时保留 180ms 淡出(useThinkingPresence 控制 visible)
  const visible = useThinkingPresence(show);
  if (!visible) return null;
  return (
    <div
      aria-live="polite"
      className={cn(
        'overflow-hidden transition-all duration-200',
        show ? 'max-h-20 opacity-100 translate-y-0' : 'max-h-0 opacity-0 -translate-y-2'
      )}
    >
      <p className="text-sm text-muted-foreground">
        {/* Shimmer 默认渲染为 <p>，作为 <p> 的子节点会触发 HTML 嵌套违规和水合错误；显式改为 <span> */}
        <Shimmer as="span" duration={1}>Thinking…</Shimmer>
      </p>
    </div>
  );
}
