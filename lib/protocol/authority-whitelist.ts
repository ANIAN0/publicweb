/**
 * UIMessageChunk 权威 type 白名单门闸（C-003 / T-002）。
 * 对照 project-kb/decisions/uimessagechunk-authority-type-whitelist.md（用户暂定可改表）。
 *
 * 规则：权威 → 写库+推流；仅流 → 不写 messages；未知 type → 仅流 + 可观测日志。
 */

import type { UIMessageChunk } from './events';
import { debugLog } from '@/lib/debug-log';

/** 权威白名单（条件权威见 isAuthorityChunk） */
const AUTHORITY_TYPES = new Set<string>([
  'start',
  'message-metadata',
  'finish',
  'abort',
  'error',
  'text-end',
  'reasoning-end',
  'tool-input-start',
  'tool-input-available',
  'tool-input-error',
  'tool-approval-request',
  'tool-approval-response',
  'tool-output-available',
  'tool-output-error',
  'tool-output-denied',
  'source-url',
  'source-document',
  'file',
  'reasoning-file',
]);

/** 明确仅流 type（不写库） */
const STREAM_ONLY_TYPES = new Set<string>([
  'text-start',
  'text-delta',
  'reasoning-start',
  'reasoning-delta',
  'tool-input-delta',
  'start-step',
  'finish-step',
  'custom',
]);

/**
 * 是否应对该 chunk 执行权威 persist（写库）。
 * - tool-output-available + preliminary:true → 仅流
 * - data-* + transient:true → 仅流
 * - data-* 无 transient 或 transient:false → 权威
 * - 未知 type → 仅流 + 日志
 */
export function isAuthorityChunk(chunk: UIMessageChunk): boolean {
  const type = chunk.type;

  // data-* 条件权威
  if (typeof type === 'string' && type.startsWith('data-')) {
    const transient = (chunk as { transient?: boolean }).transient === true;
    return !transient;
  }

  // tool-output-available：preliminary 仅流
  if (type === 'tool-output-available') {
    return (chunk as { preliminary?: boolean }).preliminary !== true;
  }

  if (AUTHORITY_TYPES.has(type)) return true;
  if (STREAM_ONLY_TYPES.has(type)) return false;

  // 未知 type：默认仅流，可观测
  debugLog('persist', `unknown chunk type (stream-only): ${type}`);
  return false;
}

/** 是否为 turn 终态 chunk（幂等门闸） */
export function isTerminalChunk(chunk: UIMessageChunk): boolean {
  return chunk.type === 'finish' || chunk.type === 'abort' || chunk.type === 'error';
}

/** 导出门闸集合供测试/文档对照（只读） */
export function listAuthorityTypes(): readonly string[] {
  return [...AUTHORITY_TYPES];
}

export function listStreamOnlyTypes(): readonly string[] {
  return [...STREAM_ONLY_TYPES];
}
