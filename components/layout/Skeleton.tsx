// 列表骨架:加载时渲染贴合最终布局的灰条占位
// LAYOUT-001：抽出可复用 Skeleton 原语（对齐 shadcn skeleton 的 animate-pulse 语义）
import { cn } from '@/lib/utils';

/** 基础骨架块（等同 shadcn Skeleton 最小实现） */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('rounded-md bg-muted animate-pulse', className)} />;
}

// 单行骨架:模拟列表项高度
export function SkeletonRow({ className }: { className?: string }) {
  return <Skeleton className={cn('h-12 rounded-lg', className)} />;
}

// 列表骨架:渲染 count 个 SkeletonRow
export function SkeletonList({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('mx-auto max-w-3xl space-y-1', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}
