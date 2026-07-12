// LIB-024：通用 parts 文本提取，从 backends/persist 解耦
import type { PersistedPart } from '@/lib/protocol/events';

/** 解析 parts JSON；空/损坏返回 [] */
function parseParts(json: string | null | undefined): PersistedPart[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * 从 parts JSON 拼接所有 text part 的文本。
 * 供 history 重建、clientContext 等路径使用。
 */
export function extractTextFromParts(partsJson: string | null | undefined): string {
  return parseParts(partsJson)
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text?: string }).text ?? '')
    .join('');
}
