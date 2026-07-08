'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { ComponentType } from 'react';
import { Cloud, Terminal, Code, ArrowLeft, Check } from 'lucide-react';

interface BackendDescriptor { id: string; label: string; description: string }
interface ModelInfo { id: string; label: string; isDefault?: boolean }
interface ExecutionTarget {
  id: string;
  name: string;
  online: boolean;
  models: ModelInfo[];
  meta?: Record<string, string>;
}

// 步骤:后端 → 端点 → 模型。模型步按 target.models 数量决定是否显示(单模型自动跳过选择)。
// 所有后端走同一条代码路径,差异在适配器返回的 target.models 数量,不按 backend 名分叉。
const STEPS = [
  { key: 'backend', label: '后端' },
  { key: 'target', label: '端点' },
  { key: 'model', label: '模型' },
] as const;

// 后端图标映射(展示层,非逻辑分叉)
const BACKEND_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  eveagent: Cloud,
  claudecode: Terminal,
  pi: Code,
};

export default function NewSession() {
  const router = useRouter();
  const [step, setStep] = useState<'backend' | 'target' | 'model'>('backend');
  const [backends, setBackends] = useState<BackendDescriptor[]>([]);
  const [backend, setBackend] = useState<string>('');
  const [targets, setTargets] = useState<ExecutionTarget[]>([]);
  const [targetId, setTargetId] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [cwd, setCwd] = useState<string>('');  // 工作目录(local 可选,留空用 client 运行目录)
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>('');

  const currentIndex = STEPS.findIndex((s) => s.key === step);
  const selectedTarget = targets.find((t) => t.id === targetId);

  // 拉后端列表(数据驱动,不硬编码 3 张卡片)
  useEffect(() => {
    fetch('/api/backends').then((r) => r.json()).then((b: BackendDescriptor[]) => setBackends(b));
  }, []);

  // 选后端后拉端点列表(适配器返回,local=设备,eveagent=eve 服务)
  useEffect(() => {
    if (step !== 'target' || !backend) return;
    fetch(`/api/backends/${backend}/targets`).then((r) => r.json()).then((t: ExecutionTarget[]) => {
      setTargets(t);
      // 唯一在线端点:自动选中 + 同步选 model(单模型端点步直接可创建,多模型进模型步可改)
      const onlineOnes = t.filter((x) => x.online);
      if (onlineOnes.length === 1) {
        const only = onlineOnes[0];
        setTargetId(only.id);
        if (only.models.length >= 1) {
          const def = only.models.find((m) => m.isDefault) ?? only.models[0];
          setModel(def.id);
        }
      }
    });
  }, [step, backend]);

  // 选端点:同步选 model(单模型自动选默认;多模型选默认作为初值,模型步可改)。
  // 关键:不在此处跳步——是否进模型步由端点步底部的"下一步"按钮决定(仅多模型显示)。
  // 这样从模型步返回端点步时,不会因 targetId 仍在而被 effect 再次推进(死循环)。
  const selectTarget = (id: string) => {
    setTargetId(id);
    const t = targets.find((x) => x.id === id);
    if (t && t.models.length >= 1) {
      const def = t.models.find((m) => m.isDefault) ?? t.models[0];
      setModel(def.id);
    } else {
      setModel('');
    }
  };

  const handleCreate = async () => {
    if (!backend || !targetId || !model) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend, targetId, model, cwd: cwd || undefined }),
      });
      if (res.ok) {
        const data = await res.json();
        router.push(`/sessions/${data.id}`);
      } else {
        const err = await res.json();
        setError(err.error ?? 'create failed');
      }
    } finally {
      setSubmitting(false);
    }
  };

  // 步骤条点回:只允许跳到当前及之前步骤
  const goToStep = (key: 'backend' | 'target' | 'model') => {
    const idx = STEPS.findIndex((s) => s.key === key);
    if (idx <= currentIndex) setStep(key);
  };

  const handleBack = () => setStep(step === 'model' ? 'target' : 'backend');

  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-12">
      <div className="w-full max-w-2xl">
        {/* 返回首页 */}
        <Link href="/" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> 返回首页
        </Link>
        {/* 标题区 */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold">新建会话</h1>
          <p className="mt-1 text-sm text-muted-foreground">选择后端、端点与模型,创建一个新会话</p>
        </div>

        {/* 步骤条 */}
        <div className="mb-8 flex items-center gap-2">
          {STEPS.map((s, i) => {
            const active = s.key === step;
            const reached = i <= currentIndex;
            return (
              <div key={s.key} className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!reached}
                  onClick={() => goToStep(s.key)}
                  className={cn(
                    'flex items-center gap-1.5 text-sm transition-colors',
                    active ? 'text-foreground' : reached ? 'text-muted-foreground hover:text-foreground' : 'text-muted-foreground/40',
                    !reached && 'cursor-not-allowed',
                  )}
                >
                  <span className={cn(
                    'flex size-6 items-center justify-center rounded-full text-xs font-medium transition-colors',
                    active ? 'bg-primary text-primary-foreground' : reached ? 'bg-muted text-muted-foreground' : 'bg-muted/50',
                  )}>{i + 1}</span>
                  {s.label}
                </button>
                {i < STEPS.length - 1 && <div className="h-px w-8 bg-border" />}
              </div>
            );
          })}
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
        )}

        {/* Step 1: 后端 —— 从 /api/backends 拉取,数据驱动渲染 */}
        {step === 'backend' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {backends.map((b) => {
              const Icon = BACKEND_ICONS[b.id] ?? Terminal;
              return (
                <Button
                  key={b.id}
                  variant="outline"
                  onClick={() => {
                    setBackend(b.id);
                    // 重置下游选择,避免切后端时残留
                    setTargetId('');
                    setModel('');
                    setTargets([]);
                    setStep('target');
                  }}
                  className="h-auto flex-col items-start gap-2 p-4 text-left"
                >
                  <Icon className="size-6" />
                  <div>
                    <div className="font-medium">{b.label}</div>
                    <div className="text-xs text-muted-foreground">{b.description}</div>
                  </div>
                </Button>
              );
            })}
          </div>
        )}

        {/* Step 2: 端点 —— local=设备,eveagent=eve 服务;离线置灰;单模型端点显示模型徽标 */}
        {step === 'target' && (
          <div className="w-full">
            <h2 className="mb-4 text-lg font-medium">选择端点</h2>
            {targets.length === 0 ? (
              <div className="text-sm text-muted-foreground">没有可用的端点</div>
            ) : (
              <div className="space-y-1">
                {targets.map((t) => {
                  const isOffline = !t.online;
                  const selected = targetId === t.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => { if (!isOffline) selectTarget(t.id); }}
                      disabled={isOffline}
                      className={cn(
                        'flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left ring-2 ring-transparent transition-colors',
                        selected ? 'bg-accent ring-primary' : isOffline ? 'cursor-not-allowed opacity-50' : 'hover:bg-muted/50',
                      )}
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{t.name}</span>
                          {isOffline && <Badge variant="secondary">离线</Badge>}
                          {/* 单模型端点(eveagent)直接在端点行显示模型;多模型在下一步选 */}
                          {t.models.length === 1 && <Badge variant="outline">{t.models[0].label}</Badge>}
                        </div>
                        {/* meta 展示:设备 hostname 或 eve 服务 host */}
                        {(t.meta?.hostname || t.meta?.host) && (
                          <div className="mt-0.5 text-xs text-muted-foreground">{t.meta.hostname || t.meta.host}</div>
                        )}
                      </div>
                      {selected && <Check className="size-4 text-primary" />}
                    </button>
                  );
                })}
              </div>
            )}
            {/* local 端点可选工作目录:claudecode/pi 子进程的 cwd;留空用 client 运行目录 */}
            {selectedTarget && (backend === 'claudecode' || backend === 'pi') && (
              <div className="mt-3">
                <label className="text-xs text-muted-foreground">工作目录(可选)</label>
                <Input
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="留空用 client 运行目录"
                  className="mt-1"
                />
              </div>
            )}
            <div className="mt-4 flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={handleBack}>
                <ArrowLeft />
                返回
              </Button>
              {/* 单模型端点(eveagent):端点行已显示模型徽标,直接创建,无需进模型步 */}
              {selectedTarget && selectedTarget.models.length === 1 && (
                <Button onClick={handleCreate} disabled={submitting}>
                  {submitting && <Spinner className="size-4" />}
                  {submitting ? '创建中...' : '创建会话'}
                </Button>
              )}
              {/* 多模型端点(local):进模型步选模型 */}
              {selectedTarget && selectedTarget.models.length > 1 && (
                <Button onClick={() => setStep('model')}>下一步</Button>
              )}
              {/* 零模型:无法创建,提示 */}
              {selectedTarget && selectedTarget.models.length === 0 && (
                <span className="text-sm text-muted-foreground">该端点未上报模型清单</span>
              )}
            </div>
          </div>
        )}

        {/* Step 3: 模型 —— 单模型自动选中(展示用),多模型让选;零模型提示 */}
        {step === 'model' && (
          <div className="w-full">
            <h2 className="mb-4 text-lg font-medium">选择模型</h2>
            {!selectedTarget || selectedTarget.models.length === 0 ? (
              <div className="text-sm text-muted-foreground">该端点未上报模型清单</div>
            ) : (
              <div className="space-y-1">
                {selectedTarget.models.map((m) => {
                  const selected = model === m.id;
                  return (
                    <button
                      key={m.id}
                      onClick={() => setModel(m.id)}
                      className={cn(
                        'flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left ring-2 ring-transparent transition-colors',
                        selected ? 'bg-accent ring-primary' : 'hover:bg-muted/50',
                      )}
                    >
                      <span className="font-medium">{m.label || m.id}</span>
                      <div className="flex items-center gap-2">
                        {m.isDefault && <Badge variant="secondary">默认</Badge>}
                        {selected && <Check className="size-4 text-primary" />}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="mt-4 flex justify-between">
              <Button variant="ghost" size="sm" onClick={handleBack}>
                <ArrowLeft />
                返回
              </Button>
              <Button onClick={handleCreate} disabled={!model || submitting}>
                {submitting && <Spinner className="size-4" />}
                {submitting ? '创建中...' : '创建会话'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
