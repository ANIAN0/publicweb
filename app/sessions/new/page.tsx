'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Device {
  id: string;
  name: string;
  hostname?: string;
  online: boolean;
  supportedBackends: string[];
}

interface ModelInfo { id: string; label: string; isDefault?: boolean }

// 3 步向导：后端卡片 → 设备选择（仅 claudecode/pi）→ 模型选择
// T-004 范围：加 claudecode 卡片 + 设备选择；完整的多设备新会话向导在 T-006
export default function NewSession() {
  const router = useRouter();
  const [step, setStep] = useState<'backend' | 'device' | 'model'>('backend');
  const [backend, setBackend] = useState<string>('');
  const [deviceId, setDeviceId] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>('');

  // 进入 device step 时拉设备
  // 修复 REV-005-10：渲染所有支持该后端的设备；离线项置灰且不可选（F-011 验收）。
  // 跳过 Step 2 仅当"有且仅有一台在线支持设备"才成立。
  useEffect(() => {
    if (step !== 'device') return;
    fetch('/api/devices')
      .then((r) => r.json())
      .then((data: Device[]) => {
        const supporting = data.filter((d) => d.supportedBackends.includes(backend));
        setDevices(supporting);
        const onlineOnes = supporting.filter((d) => d.online);
        if (onlineOnes.length === 1) {
          // 唯一在线支持设备：跳过选择
          setDeviceId(onlineOnes[0].id);
          setStep('model');
        }
      });
  }, [step, backend]);

  // 进入 model step 时拉模型
  useEffect(() => {
    if (step !== 'model' || !deviceId || !backend) return;
    fetch(`/api/devices/${deviceId}/models`)
      .then((r) => r.json())
      .then((rows: { backend: string; models: ModelInfo[] }[]) => {
        const row = rows.find((r) => r.backend === backend);
        setModels(row?.models ?? []);
        // 默认选 default 或第一项
        if (row?.models) {
          const def = row.models.find((m) => m.isDefault) ?? row.models[0];
          if (def) setModel(def.id);
        }
      });
  }, [step, deviceId, backend]);

  const handleCreate = async () => {
    if (!backend || !model) return;
    setSubmitting(true);
    setError('');
    try {
      const body: Record<string, string> = { backend, model };
      if (deviceId) body.deviceId = deviceId;
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        const data = await response.json();
        router.push(`/sessions/${data.id}`);
      } else {
        const err = await response.json();
        setError(err.error ?? 'create failed');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8">
      <h1 className="text-2xl font-bold mb-8">新建会话</h1>

      {error && <div className="text-red-500 mb-4">{error}</div>}

      {step === 'backend' && (
        <div className="grid grid-cols-3 gap-4">
          <BackendCard
            title="Eveagent"
            subtitle="远程云端 agent"
            colorClass="border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950"
            onClick={() => { setBackend('eveagent'); setStep('model'); }}
          />
          <BackendCard
            title="Claude Code"
            subtitle="本地 claudecode CLI"
            colorClass="border-purple-500 hover:bg-purple-50 dark:hover:bg-purple-950"
            onClick={() => { setBackend('claudecode'); setStep('device'); }}
          />
          <BackendCard
            title="Pi"
            subtitle="本地 pi CLI"
            colorClass="border-green-500 hover:bg-green-50 dark:hover:bg-green-950"
            onClick={() => { setBackend('pi'); setStep('device'); }}
          />
        </div>
      )}

      {step === 'device' && (
        <div className="w-full max-w-md">
          <h2 className="text-lg mb-4">选择设备</h2>
          {devices.length === 0 ? (
            <div className="text-zinc-500">没有支持 {backend} 的设备，请先在
              <a href="/devices" className="text-blue-500 mx-1">设备管理</a>添加
            </div>
          ) : (
            <div className="space-y-2">
              {devices.map((d) => {
                // 离线设备置灰且不可点（F-011 / REV-005-10）
                const isOffline = !d.online;
                return (
                  <button
                    key={d.id}
                    onClick={() => { if (!isOffline) { setDeviceId(d.id); setStep('model'); } }}
                    disabled={isOffline}
                    aria-disabled={isOffline}
                    className={`w-full text-left p-3 border rounded ${
                      isOffline
                        ? 'opacity-50 cursor-not-allowed bg-zinc-100 dark:bg-zinc-900'
                        : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <div className="font-medium flex items-center gap-2">
                      {d.name}
                      {isOffline && <span className="text-xs text-zinc-500">(离线)</span>}
                    </div>
                    <div className="text-xs text-zinc-500">{d.hostname || '—'}</div>
                  </button>
                );
              })}
            </div>
          )}
          <button
            onClick={() => setStep('backend')}
            className="mt-4 text-sm text-zinc-500 hover:underline"
          >← 返回</button>
        </div>
      )}

      {step === 'model' && (
        <div className="w-full max-w-md">
          <h2 className="text-lg mb-4">选择模型</h2>
          {models.length === 0 ? (
            <div className="text-zinc-500">该设备未上报模型清单</div>
          ) : (
            <div className="space-y-2">
              {models.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setModel(m.id)}
                  className={`w-full text-left p-3 border rounded ${
                    model === m.id ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
                  }`}
                >
                  {m.label || m.id}
                  {m.isDefault && <span className="ml-2 text-xs text-zinc-500">default</span>}
                </button>
              ))}
            </div>
          )}
          <div className="flex justify-between mt-4">
            <button
              onClick={() => setStep(backend === 'eveagent' ? 'backend' : 'device')}
              className="text-sm text-zinc-500 hover:underline"
            >← 返回</button>
            <button
              onClick={handleCreate}
              disabled={!model || submitting}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
            >{submitting ? '创建中...' : '创建会话'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function BackendCard({ title, subtitle, colorClass, onClick }: {
  title: string; subtitle: string; colorClass: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`p-6 border-2 rounded-lg text-left ${colorClass}`}
    >
      <div className="text-lg font-semibold">{title}</div>
      <div className="text-sm text-zinc-500 mt-1">{subtitle}</div>
    </button>
  );
}
