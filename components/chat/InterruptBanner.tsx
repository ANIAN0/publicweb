'use client';

// 中断横幅：device 离线 / session.disconnected 时显示
// 不遮挡消息流：sticky top，message-list 用 overflow-y-auto；点击"重试"调外部 onRetry
export interface InterruptBannerProps {
  open: boolean;
  reason?: string;
  busy?: boolean;
  onRetry: () => void;
  onDismiss?: () => void;
}

export function InterruptBanner({ open, reason, busy, onRetry, onDismiss }: InterruptBannerProps) {
  if (!open) return null;

  return (
    <div
      // sticky 在消息列表顶端，不挡输入框；顶部留点 padding 让内容不被遮
      className="sticky top-0 z-10 mx-4 mt-2 mb-2 px-4 py-3 bg-yellow-50 dark:bg-yellow-950 border border-yellow-300 dark:border-yellow-700 rounded shadow-sm flex items-center justify-between gap-3"
      role="alert"
    >
      <div className="flex items-center gap-2 text-sm text-yellow-900 dark:text-yellow-200">
        <span>⚠</span>
        <span>
          {reason === 'device_offline' ? '设备已断开，等待重连...' : '连接已断开'}
        </span>
      </div>
      <div className="flex gap-2 shrink-0">
        <button
          onClick={onRetry}
          disabled={busy}
          className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
        >
          {busy ? '重试中...' : '重试'}
        </button>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="px-2 py-1 text-sm text-yellow-900 dark:text-yellow-200 hover:bg-yellow-100 dark:hover:bg-yellow-900 rounded"
            aria-label="关闭"
          >✕</button>
        )}
      </div>
    </div>
  );
}