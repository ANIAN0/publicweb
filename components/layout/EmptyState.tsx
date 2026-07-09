// 空状态:icon + 标题 + 描述 + 可选 CTA + 可选帮助链接
// 三页(首页/设备/Eve 服务)统一结构,消除各页 empty 文案/结构不一致
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
