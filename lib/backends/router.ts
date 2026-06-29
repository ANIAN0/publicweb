import { BackendAdapter } from './types';
import { EveagentBackend } from './eveagent';

const adapters = new Map<string, BackendAdapter>();

export function getBackendAdapter(backend: string): BackendAdapter {
  let adapter = adapters.get(backend);
  if (!adapter) {
    if (backend === 'eveagent') {
      adapter = new EveagentBackend();
    } else {
      throw new Error(`Unsupported backend: ${backend}`);
    }
    adapters.set(backend, adapter);
  }
  return adapter;
}