// 错误横幅:页面级错误(拉列表失败/整体不可用)统一展示
// LAYOUT-003：与 InterruptBanner 同用 Alert，但职责不同——列表/页级错误 vs 会话断连
// 用 shadcn Alert destructive + 友好文案 + 重试按钮
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Alert, AlertTitle, AlertAction } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export interface ErrorBannerProps {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}

export function ErrorBanner({ message, onRetry, retrying }: ErrorBannerProps) {
  return (
    <Alert variant="destructive" className="mx-6 mb-4 rounded-lg">
      <AlertCircle />
      <AlertTitle>{message}</AlertTitle>
      {onRetry && (
        <AlertAction>
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
            <RefreshCw className={retrying ? 'animate-spin' : undefined} />
            重试
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}
