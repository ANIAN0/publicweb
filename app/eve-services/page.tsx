'use client';

// eve 服务管理页：CRUD + auth 配置（none/bearer/headers）+ 探活反馈 + 导航入口
// 后端 API 已就绪：GET/POST /api/eve-services，PATCH/DELETE /api/eve-services/[id]
// 探活：GET /api/backends/eveagent/targets 返回 online 状态
import { useEffect, useState, useCallback } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Cloud, Plus, MoreHorizontal, Trash2, Pencil, RefreshCw, CheckCircle2, XCircle, ArrowLeft } from 'lucide-react';
import Link from 'next/link';

interface EveService {
  id: string;
  name: string;
  host: string;
  model: string;
  authType: string; // none/bearer/headers
  authConfig: string | null; // 脱敏：bearer→{hasToken}，headers→{headerNames}
  online: boolean | null;
  createdAt: string;
}

// auth 配置表单值
interface AuthForm {
  authType: 'none' | 'bearer' | 'headers';
  bearerToken: string; // bearer 输入
  headerKeys: string; // headers 输入（key:value 每行一组）
}

export default function EveServicesPage() {
  const [services, setServices] = useState<EveService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 添加/编辑对话框
  const [editing, setEditing] = useState<EveService | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<EveService | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchServices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/eve-services');
      if (!res.ok) throw new Error(`加载失败: ${res.status}`);
      const data = await res.json();
      setServices(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchServices(); }, [fetchServices]);

  // 探活：GET /api/backends/eveagent/targets 返回 online
  const probeServices = async () => {
    try {
      const res = await fetch('/api/backends/eveagent/targets');
      if (res.ok) {
        const targets = await res.json();
        // 用 targets 的 online 更新 services
        setServices((prev) => prev.map((s) => {
          const t = targets.find((x: { id: string; online: boolean }) => x.id === s.id);
          return t ? { ...s, online: t.online } : s;
        }));
      }
    } catch { /* 探活失败不阻塞 */ }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/eve-services/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) { alert('删除失败'); return; }
      setDeleteTarget(null);
      fetchServices();
    } finally { setDeleting(false); }
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <Link href="/" className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}>
            <ArrowLeft className="size-4" />
          </Link>
          <Cloud className="size-5" />
          <span className="text-lg font-semibold">Eve 服务管理</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { fetchServices(); probeServices(); }} disabled={loading}>
            {loading ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
            刷新
          </Button>
          <Button size="sm" onClick={() => setShowAdd(true)}>
            <Plus className="size-4" /> 添加服务
          </Button>
        </div>
      </header>

      {error && (
        <div className="mx-6 mb-4 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-center justify-between">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={fetchServices}>重试</Button>
        </div>
      )}

      <main className="flex-1 overflow-y-auto px-6 pb-8">
        {loading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            <Spinner className="mx-auto size-6 mb-2" />加载中...
          </div>
        ) : services.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Cloud className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">暂无 eve 服务</p>
            <Button variant="outline" size="sm" onClick={() => setShowAdd(true)}>
              <Plus className="size-4" /> 添加第一个服务
            </Button>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-2">
            {services.map((svc) => (
              <Card key={svc.id} className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{svc.name}</span>
                      {svc.online === true ? (
                        <Badge variant="default" className="bg-green-500/10 text-green-600 border-green-500/20">
                          <CheckCircle2 className="size-3 mr-1" /> 在线
                        </Badge>
                      ) : svc.online === false ? (
                        <Badge variant="secondary"><XCircle className="size-3 mr-1" /> 离线</Badge>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground truncate">{svc.host}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant="outline" className="text-xs">{svc.model}</Badge>
                      {svc.authType && svc.authType !== 'none' && (
                        <Badge variant="outline" className="text-xs">auth: {svc.authType}</Badge>
                      )}
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}>
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditing(svc)}>
                        <Pencil className="size-4" /> 编辑
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                        onClick={() => setDeleteTarget(svc)}
                      >
                        <Trash2 className="size-4" /> 删除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </Card>
            ))}
          </div>
        )}
      </main>

      {/* 添加/编辑对话框 */}
      {(showAdd || editing) && (
        <EveServiceDialog
          service={editing}
          onClose={() => { setShowAdd(false); setEditing(null); }}
          onSaved={() => { setShowAdd(false); setEditing(null); fetchServices(); }}
        />
      )}

      {/* 删除确认 */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 eve 服务?</DialogTitle>
            <DialogDescription>确定要删除「{deleteTarget?.name}」吗？关联会话仍保留历史。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>取消</Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting && <Spinner className="size-4" />}删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// 添加/编辑 eve 服务的对话框
function EveServiceDialog({ service, onClose, onSaved }: { service: EveService | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(service?.name ?? '');
  const [host, setHost] = useState(service?.host ?? '');
  const [model, setModel] = useState(service?.model ?? '');
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'headers'>(
    (service?.authType as 'none' | 'bearer' | 'headers') ?? 'none'
  );
  const [bearerToken, setBearerToken] = useState('');
  const [headerKeys, setHeaderKeys] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim() || !host.trim() || !model.trim()) {
      setError('name/host/model 必填');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // 构造 authConfig
      let authConfig: string | undefined;
      if (authType === 'bearer' && bearerToken.trim()) {
        authConfig = JSON.stringify({ token: bearerToken.trim() });
      } else if (authType === 'headers' && headerKeys.trim()) {
        // headerKeys 格式：每行 key:value
        const headers: Record<string, string> = {};
        for (const line of headerKeys.split('\n')) {
          const idx = line.indexOf(':');
          if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
        authConfig = JSON.stringify({ headers });
      }

      const body: Record<string, unknown> = { name, host, model, authType };
      if (authConfig) body.authConfig = authConfig;

      const url = service ? `/api/eve-services/${service.id}` : '/api/eve-services';
      const method = service ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error ?? `保存失败: ${res.status}`);
        return;
      }
      onSaved();
    } catch {
      setError('保存失败: 网络错误');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{service ? '编辑 eve 服务' : '添加 eve 服务'}</DialogTitle>
          <DialogDescription>配置 eve 服务端点（host + 模型 + 认证）</DialogDescription>
        </DialogHeader>
        {error && <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        <div className="space-y-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="服务名称（如：云端 eve）" />
          <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="host（如：https://xxx.hf.space）" />
          <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型（如：anthropic/claude-sonnet-5）" />
          {/* auth 配置 */}
          <div className="space-y-2">
            <div className="text-sm font-medium">认证方式</div>
            <Select value={authType} onValueChange={(v) => setAuthType(v as 'none' | 'bearer' | 'headers')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">无认证</SelectItem>
                <SelectItem value="bearer">Bearer Token</SelectItem>
                <SelectItem value="headers">自定义 Headers</SelectItem>
              </SelectContent>
            </Select>
            {authType === 'bearer' && (
              <Input value={bearerToken} onChange={(e) => setBearerToken(e.target.value)} placeholder="Bearer Token" type="password" />
            )}
            {authType === 'headers' && (
              <textarea
                value={headerKeys}
                onChange={(e) => setHeaderKeys(e.target.value)}
                placeholder="每行一个 header，格式 key:value&#10;x-api-key:xxx"
                className="min-h-16 w-full resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            )}
            {service && authType !== 'none' && (
              <p className="text-xs text-muted-foreground">编辑时不填 token/headers 则保留原值</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Spinner className="size-4" />}{service ? '保存' : '添加'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
