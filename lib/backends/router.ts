// 路由 backend 名字 → adapter 实例
// eveagent(远程)走 EveagentBackend;claudecode/pi(本地)各一个 LocalBackend 实例(构造参数化区分)
import { BackendAdapter, BackendDescriptor } from './types';
import { EveagentBackend } from './eveagent';
import { LocalBackend } from './local';

const adapters = new Map<string, BackendAdapter>();

function register(adapter: BackendAdapter): void {
  adapters.set(adapter.id, adapter);
}

// 注册三后端:claudecode/pi 共用 LocalBackend 实现,靠构造参数区分 id/label
register(new EveagentBackend());
register(new LocalBackend('claudecode', 'Claude Code', '本地 claudecode CLI'));
register(new LocalBackend('pi', 'Pi', '本地 pi CLI'));

export function getBackendAdapter(backend: string): BackendAdapter {
  const adapter = adapters.get(backend);
  if (!adapter) throw new Error(`Unsupported backend: ${backend}`);
  return adapter;
}

// 列出所有后端描述符,前端数据驱动渲染后端卡片
export function listBackends(): BackendDescriptor[] {
  return Array.from(adapters.values()).map(({ id, label, description }) => ({ id, label, description }));
}
