// 后端 id → 显示名映射,首页筛选 chip + 设备页徽标共用
import type { BackendDescriptor } from './types';

export const BACKEND_LABEL: Record<BackendDescriptor['id'], string> = {
  eveagent: 'Eveagent',
  claudecode: 'Claude Code',
  pi: 'Pi',
};

// backend id → 显示名,未知 backend 回退原值(如设备 supportedBackends 含未登记 backend)
export function backendLabel(b: string): string {
  return (BACKEND_LABEL as Record<string, string>)[b] ?? b;
}
