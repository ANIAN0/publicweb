// 列表骨架:加载时渲染贴合最终布局的灰条占位,替代纯文字/spinner
// 设计参考 Notion 骨架屏(内容形占位,加载完成无布局跳动)
// animate-pulse 呼吸;reduced-motion 由 globals.css 全局守护降级为瞬切
import { cn } from '@/lib/utils';

// 单行骨架:模拟列表项高度
export function SkeletonRow({ className }: { className?: string }) {
  return <div className={cn('h-12 rounded-lg bg-muted animate-pulse', className)} />;
}

// 列表骨架:渲染 count 个 SkeletonRow,间距与真实列表一致
export function SkeletonList({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('mx-auto max-w-3xl space-y-1', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}
