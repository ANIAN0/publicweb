'use client';

// 添加设备对话框：shadcn Dialog + 复制 token/命令 + 失败反馈 + 上线感知（轮询）
import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Copy, Check, Loader2 } from 'lucide-react';

interface Props {
  onClose: () => void;
  onDeviceAdded: () => void;
}

export default function AddDeviceDialog({ onClose, onDeviceAdded }: Props) {
  const [deviceName, setDeviceName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [command, setCommand] = useState('');
  const [copied, setCopied] = useState<'token' | 'command' | null>(null);
  // 上线感知：生成 token 后轮询设备列表，设备上线自动关闭
  const [waiting, setWaiting] = useState(false);

  const handleGenerate = async () => {
    if (!deviceName.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/setup-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceName }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error ?? `生成失败: ${res.status}`);
        return;
      }
      const data = await res.json();
      setToken(data.setupToken);
      setCommand(data.command);
      setWaiting(true);
    } catch {
      setError('生成失败: 网络错误');
    } finally {
      setLoading(false);
    }
  };

  // 上线感知：3s 轮询设备列表，检测同名设备上线
  useEffect(() => {
    if (!waiting) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/devices');
        if (res.ok) {
          const data = await res.json();
          // 检测同名设备上线
          const found = data.find((d: { name: string; online: boolean }) => d.name === deviceName && d.online);
          if (found) {
            setWaiting(false);
            onDeviceAdded();
          }
        }
      } catch { /* 忽略轮询错误 */ }
    }, 3000);
    return () => clearInterval(interval);
  }, [waiting, deviceName, onDeviceAdded]);

  // 复制到剪贴板
  const copy = (text: string, type: 'token' | 'command') => {
    navigator.clipboard.writeText(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加设备</DialogTitle>
          <DialogDescription>
            {token ? '在本地 client 运行以下命令注册设备' : '输入设备名称生成注册 token'}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
        )}

        {!token ? (
          <>
            <Input
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="设备名称（如：我的笔记本）"
              onKeyDown={(e) => e.key === 'Enter' && handleGenerate()}
              autoFocus
            />
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>取消</Button>
              <Button onClick={handleGenerate} disabled={loading || !deviceName.trim()}>
                {loading && <Spinner className="size-4" />}
                {loading ? '生成中...' : '生成 Token'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-3">
              {/* 注册命令（一键复制） */}
              <div>
                <div className="text-sm font-medium mb-1">注册命令</div>
                <div className="flex gap-2">
                  <pre className="flex-1 overflow-x-auto rounded-md bg-muted p-3 text-xs">{command}</pre>
                  <Button variant="outline" size="icon" onClick={() => copy(command, 'command')} title="复制命令">
                    {copied === 'command' ? <Check className="size-4" /> : <Copy className="size-4" />}
                  </Button>
                </div>
              </div>
              {/* Setup Token（备用，一键复制） */}
              <div>
                <div className="text-sm font-medium mb-1">Setup Token（备用）</div>
                <div className="flex gap-2">
                  <code className="flex-1 overflow-x-auto rounded-md bg-muted p-3 text-xs">{token}</code>
                  <Button variant="outline" size="icon" onClick={() => copy(token, 'token')} title="复制 Token">
                    {copied === 'token' ? <Check className="size-4" /> : <Copy className="size-4" />}
                  </Button>
                </div>
              </div>
              {/* 上线感知提示 */}
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                {waiting ? (
                  <><Loader2 className="size-3 animate-spin" /> 等待设备上线...（设备注册后自动关闭）</>
                ) : (
                  'Token 24 小时内有效。'
                )}
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onDeviceAdded}>完成</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
