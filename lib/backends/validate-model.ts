import type { BackendAdapter } from './types';

/** 每 turn 模型覆盖必须仍属于当前执行端实时上报的 catalog。 */
export async function validateTargetModel(
  adapter: BackendAdapter,
  targetId: string,
  model: string,
): Promise<string | null> {
  const targets = await adapter.listTargets();
  const target = targets.find((item) => item.id === targetId);
  if (!target) return 'execution target not found';
  if (!target.models.some((item) => item.id === model)) {
    return `model is not available on target: ${model}`;
  }
  return null;
}
