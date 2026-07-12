// 后端 id → 显示名映射,首页筛选 chip + 设备页徽标共用
import type { BackendDescriptor } from './types';

export const BACKEND_LABEL: Record<BackendDescriptor['id'], string> = {
  eveagent: 'Eveagent',
  claudecode: 'Claude Code',
  pi: 'Pi',
};

/** 本地设备后端（WS 反向连接），用于归属校验等（WS-006 下沉） */
export const LOCAL_BACKEND_IDS = ['claudecode', 'pi'] as const;
export type LocalBackendId = (typeof LOCAL_BACKEND_IDS)[number];

export function isLocalBackendId(b: string): b is LocalBackendId {
  return (LOCAL_BACKEND_IDS as readonly string[]).includes(b);
}

// backend id → 显示名,未知 backend 回退原值(如设备 supportedBackends 含未登记 backend)
export function backendLabel(b: string): string {
  return (BACKEND_LABEL as Record<string, string>)[b] ?? b;
}
