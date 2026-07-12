// 空状态:icon + 标题 + 描述 + 可选 CTA + 可选帮助链接
// LAYOUT-002：列表页用本组件；会话区用 ConversationEmptyState（对话语义不同，有意并存）
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode; // 主 CTA(按钮)
  helpLink?: ReactNode; // 次级帮助链接
}

export function EmptyState({ icon, title, description, action, helpLink }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <div className="text-muted-foreground/40">{icon}</div>
      <p className="text-sm text-muted-foreground">{title}</p>
      {description && <p className="text-xs text-muted-foreground/70">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
      {helpLink && <div className="mt-1">{helpLink}</div>}
    </div>
  );
}
