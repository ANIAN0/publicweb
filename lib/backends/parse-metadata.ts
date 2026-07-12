// 共享 metadata JSON 解析（LIB-036：pending/persist 双份合并）
import type { WebtoolMessageMetadata } from '@/lib/protocol/events';

/** 解析 metadata JSON；空/损坏返回 {} */
export function parseMessageMetadata(json: string | null | undefined): WebtoolMessageMetadata {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? (v as WebtoolMessageMetadata) : {};
  } catch {
    return {};
  }
}
