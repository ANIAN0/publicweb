'use client';

// 中断横幅：device 离线 / session.disconnected 时显示
// 视觉：destructive Alert + shadcn Button，完全 design token
// （去除原 yellow-50/blue-500/yellow-100 硬编码色 + ⚠ emoji + 裸 button，
//  与全站 ConfirmDialog/Dialog/Badge 用 destructive/primary token 的风格一致）
// 不遮挡消息流：sticky top，message-list 用 overflow-y-auto，z-10 浮在消息上方
// reason 文案：device_offline / network / restart 三种（对齐 lib/protocol/events.ts:45 union）
// 参考 multica「统一 Alert 组件 + light/cascade 模式」+ vercel/chat「错误单 banner」
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import {
  Alert,
  AlertTitle,
  AlertDescription,
  AlertAction,
} from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export interface InterruptBannerProps {
  open: boolean;
  reason?: string;
  busy?: boolean;
  onRetry: () => void;
  onDismiss?: () => void;
}

// reason → 文案：events.ts:45 的 union 三态
// 历史上曾有 device-offline（连字符）不匹配 bug，已统一为下划线
function bannerCopy(reason: string | undefined): { title: string; description: string; variant: 'destructive' | 'warning' } {
  switch (reason) {
    case 'device_offline':
      // 设备离线属可恢复态(等待客户端重连),用 warning(琥珀);network/restart 属故障态,用 destructive(红)
      return { title: '设备已断开', description: '等待本地客户端自动重连，或点击重试。', variant: 'warning' };
    case 'restart':
      return { title: '会话后端重启中', description: '正在恢复会话，请稍候。', variant: 'destructive' };
    case 'network':
      return { title: '网络中断', description: '请检查网络连接，或点击重试。', variant: 'destructive' };
    default:
      return { title: '连接已断开', description: '请点击重试恢复会话。', variant: 'destructive' };
  }
}

export function InterruptBanner({ open, reason, busy, onRetry, onDismiss }: InterruptBannerProps) {
  // 关掉时不渲染（Banner 是一次性出现的提示，避免占位）
  if (!open) return null;
  const { title, description, variant } = bannerCopy(reason);
  return (
    // AlertTitle/Description 由 has-[>svg] grid 自动布局；AlertAction 右上角绝对定位
    // sticky top 让 Banner 跟消息列表一起向下滚时停留在视口顶端
    <Alert
      variant={variant}
      className="sticky top-0 z-10 mx-4 mt-2 mb-2 rounded-lg border"
    >
      <AlertTriangle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
      <AlertAction>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRetry}
            disabled={busy}
          >
            {busy ? (
              <>
                <RefreshCw className="animate-spin" />
                重试中…
              </>
            ) : (
              <>
                <RefreshCw />
                重试
              </>
            )}
          </Button>
          {onDismiss && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onDismiss}
              aria-label="关闭"
            >
              <X />
            </Button>
          )}
        </div>
      </AlertAction>
    </Alert>
  );
}
