// 路由 backend 名字 → adapter 实例
// 本期：eveagent（远程）走 EveagentBackend；claudecode / pi（本地）走 LocalBackend
import { BackendAdapter } from './types';
import { EveagentBackend } from './eveagent';
import { LocalBackend } from './local';

const adapters = new Map<string, BackendAdapter>();

export function getBackendAdapter(backend: string): BackendAdapter {
  let adapter = adapters.get(backend);
  if (!adapter) {
    if (backend === 'eveagent') {
      adapter = new EveagentBackend();
    } else if (backend === 'claudecode' || backend === 'pi') {
      // T-005 之前 claudecode 与 pi 都走 LocalBackend；pi adapter 落地后端侧无需改这里
      adapter = new LocalBackend();
    } else {
      throw new Error(`Unsupported backend: ${backend}`);
    }
    adapters.set(backend, adapter);
  }
  return adapter;
}
