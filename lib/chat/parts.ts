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
 * **不含 reasoning**——agent resume 上下文保持 text-only（D-R05）。
 * 用户导出/复制请用 {@link formatPartsForExport}。
 */
export function extractTextFromParts(partsJson: string | null | undefined): string {
  return parseParts(partsJson)
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text?: string }).text ?? '')
    .join('');
}

type ExportablePart = { type: string; text?: string };

/**
 * 按 parts 顺序拼导出/复制用纯文本：含 reasoning + text。
 * reasoning 包在「### 思考过程」标题下；空 reasoning 跳过；tool 等省略。
 * 与 {@link extractTextFromParts} 分离，避免把 think 泄漏进 agent history。
 */
export function formatPartsForExport(
  partsOrJson:
    | ReadonlyArray<ExportablePart>
    | string
    | null
    | undefined,
): string {
  const parts: ReadonlyArray<ExportablePart> =
    typeof partsOrJson === 'string' || partsOrJson == null
      ? parseParts(partsOrJson)
      : partsOrJson;

  const chunks: string[] = [];
  for (const p of parts) {
    if (p.type === 'reasoning') {
      const t = typeof p.text === 'string' ? p.text.trim() : '';
      if (!t) continue;
      chunks.push(`### 思考过程\n\n${t}`);
      continue;
    }
    if (p.type === 'text') {
      const t = typeof p.text === 'string' ? p.text : '';
      if (t) chunks.push(t);
    }
  }
  return chunks.join('\n\n').trim();
}
