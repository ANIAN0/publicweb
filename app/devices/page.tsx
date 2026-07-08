'use client';

// 设备管理页：对齐首页 shadcn 风格，补足可用性（刷新/删除/模型查看/错误态/加载态/空状态）
// 数据：GET /api/devices；模型：GET /api/devices/[id]/models；刷新模型：POST /api/devices/[id]/refresh-models
import { useEffect, useState, useCallback } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { ArrowLeft, RefreshCw, Plus, MoreHorizontal, Trash2, ChevronDown, ChevronUp, Cpu, CheckCircle2, XCircle } from 'lucide-react';
import Link from 'next/link';
import AddDeviceDialog from './_components/AddDeviceDialog';
import { formatRelative } from '@/lib/utils';
import { backendLabel } from '@/lib/backends/labels';

interface DeviceModel { id: string; label: string; isDefault?: boolean }
interface DeviceModels { backend: string; models: DeviceModel[]; refreshedAt: string | null }
interface Device {
  id: string;
  name: string;
  hostname: string;
  online: boolean;
  lastSeenAt: string | null;
  supportedBackends: string[];
}

// formatRelative 抽到 lib/utils(与首页共用,行为一致)

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  // 展开的设备模型查看
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());
  const [deviceModels, setDeviceModels] = useState<Record<string, DeviceModels[]>>({});
  // 删除二次确认
  const [deleteTarget, setDeleteTarget] = useState<Device | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchDevices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/devices');
      if (!res.ok) throw new Error(`加载失败: ${res.status}`);
      const data = await res.json();
      setDevices(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载设备失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDevices(); }, [fetchDevices]);

  // 查看模型（展开/折叠）
  const toggleModels = async (deviceId: string) => {
    const next = new Set(expandedModels);
    if (next.has(deviceId)) {
      next.delete(deviceId);
    } else {
      next.add(deviceId);
      if (!deviceModels[deviceId]) {
        try {
          const res = await fetch(`/api/devices/${deviceId}/models`);
          if (res.ok) {
            const data = await res.json();
            setDeviceModels((prev) => ({ ...prev, [deviceId]: data }));
          }
        } catch { /* 模型加载失败不阻塞 */ }
      }
    }
    setExpandedModels(next);
  };

  // 刷新模型（POST refresh-models）
  const refreshModels = async (deviceId: string) => {
    try {
      const res = await fetch(`/api/devices/${deviceId}/refresh-models`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`刷新模型失败: ${err.error ?? res.status}`);
        return;
      }
      // 刷新后重新拉模型
      const modelsRes = await fetch(`/api/devices/${deviceId}/models`);
      if (modelsRes.ok) {
        const data = await modelsRes.json();
        setDeviceModels((prev) => ({ ...prev, [deviceId]: data }));
      }
    } catch (err) {
      alert('刷新模型失败: 网络错误');
    }
  };

  // 删除设备
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/devices/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`删除失败: ${err.error ?? res.status}`);
        return;
      }
      setDeleteTarget(null);
      fetchDevices();
    } catch {
      alert('删除失败: 网络错误');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* 顶部：标题 + 操作按钮 */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-6 py-4">
        <div className="flex items-center gap-2">
          <Link href="/" className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}>
            <ArrowLeft className="size-4" />
          </Link>
          <Cpu className="size-5" />
          <span className="text-lg font-semibold">设备管理</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchDevices} disabled={loading}>
            {loading ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
            刷新
          </Button>
          <Button size="sm" onClick={() => setShowAddDialog(true)}>
            <Plus className="size-4" /> 添加设备
          </Button>
        </div>
      </header>

      {/* 错误态 */}
      {error && (
        <div className="mx-6 mb-4 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-center justify-between">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={fetchDevices}>重试</Button>
        </div>
      )}

      {/* 列表 / 加载态 / 空状态 */}
      <main className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-8">
        {loading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            <Spinner className="mx-auto size-6 mb-2" />
            加载中...
          </div>
        ) : devices.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Cpu className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">暂无设备</p>
            <Button variant="outline" size="sm" onClick={() => setShowAddDialog(true)}>
              <Plus className="size-4" /> 添加第一台设备
            </Button>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-2">
            {devices.map((device) => (
              <Card key={device.id} className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{device.name}</span>
                      {device.online ? (
                        <Badge variant="default" className="bg-green-500/10 text-green-600 border-green-500/20">
                          <CheckCircle2 className="size-3 mr-1" /> 在线
                        </Badge>
                      ) : (
                        <Badge variant="secondary">
                          <XCircle className="size-3 mr-1" /> 离线
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                      {device.hostname && <span>{device.hostname}</span>}
                      <span>最后在线: {formatRelative(device.lastSeenAt)}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {device.supportedBackends.map((b) => (
                        <Badge key={b} variant="outline" className="text-xs">
                          {backendLabel(b)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}>
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => toggleModels(device.id)}>
                        {expandedModels.has(device.id) ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                        {expandedModels.has(device.id) ? '收起模型' : '查看模型'}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => refreshModels(device.id)} disabled={!device.online}>
                        <RefreshCw className="size-4" /> 刷新模型
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                        onClick={() => setDeleteTarget(device)}
                      >
                        <Trash2 className="size-4" /> 删除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {/* 模型展开区 */}
                {expandedModels.has(device.id) && (
                  <div className="mt-3 border-t pt-3 space-y-2">
                    {deviceModels[device.id] ? (
                      deviceModels[device.id].map((row) => (
                        <div key={row.backend} className="text-xs">
                          <div className="font-medium text-muted-foreground mb-1">
                            {backendLabel(row.backend)}
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {row.models.length > 0 ? row.models.map((m) => (
                              <Badge key={m.id} variant="secondary" className="text-xs">
                                {m.label || m.id}{m.isDefault && ' (默认)'}
                              </Badge>
                            )) : <span className="text-muted-foreground">无模型</span>}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-xs text-muted-foreground"><Spinner className="size-3 mr-1" />加载模型...</div>
                    )}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </main>

      {/* 添加设备对话框 */}
      {showAddDialog && (
        <AddDeviceDialog
          onClose={() => setShowAddDialog(false)}
          onDeviceAdded={() => {
            setShowAddDialog(false);
            fetchDevices();
          }}
        />
      )}

      {/* 删除二次确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="删除设备?"
        description={<>确定要删除「{deleteTarget?.name}」吗？此操作不可恢复，设备需要重新注册。</>}
        confirmText="删除"
        busy={deleting}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
