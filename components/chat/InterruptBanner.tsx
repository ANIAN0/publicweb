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

// COMP-007：文案集中表，避免散落硬编码；i18n 未接入前保持中文默认
const BANNER_COPY: Record<
  string,
  { title: string; description: string; variant: 'destructive' | 'warning' }
> = {
  device_offline: {
    title: '设备已断开',
    description: '等待本地客户端自动重连，或点击重试。',
    variant: 'warning',
  },
  restart: {
    title: '会话后端重启中',
    description: '正在恢复会话，请稍候。',
    variant: 'destructive',
  },
  network: {
    title: '网络中断',
    description: '请检查网络连接，或点击重试。',
    variant: 'destructive',
  },
  resume_failed: {
    title: '会话恢复失败',
    description: '自动续接未成功，请点击重试。',
    variant: 'destructive',
  },
  heartbeat_timeout: {
    title: '设备心跳超时',
    description: '本地客户端可能已挂起，请检查后重试。',
    variant: 'destructive',
  },
};

const BANNER_COPY_DEFAULT = {
  title: '连接已断开',
  description: '请点击重试恢复会话。',
  variant: 'destructive' as const,
};

function bannerCopy(reason: string | undefined): {
  title: string;
  description: string;
  variant: 'destructive' | 'warning';
} {
  if (reason && BANNER_COPY[reason]) return BANNER_COPY[reason];
  return BANNER_COPY_DEFAULT;
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
