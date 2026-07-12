// 会话附件落盘：data/attachments/{sessionId}/{attachmentId}/{safeName}
// data/ 已在 .gitignore；webtool 本地运行，文件与 SQLite 同机
// LIB-031：静态 import fs/promises（热路径不需要动态 import）
import { mkdir, writeFile, readFile, access } from 'fs/promises';
import { join, basename, resolve, relative } from 'path';
import { ulid } from 'ulid';

/** 单文件上限 5MB（与 DEEIX 默认量级同级，避免 WS base64 爆内存） */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** 单次消息最多附件数 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

export type StoredAttachment = {
  id: string;
  sessionId: string;
  filename: string;
  mediaType: string;
  size: number;
  /** 磁盘绝对路径 */
  absPath: string;
  /** 前端/消息引用的相对 URL */
  url: string;
};

function attachmentsRoot(): string {
  return resolve(process.cwd(), 'data', 'attachments');
}

/** sessionId / attachmentId 仅允许安全字符，防路径遍历（LIB-029：仅本模块用，不 export） */
function assertSafeId(id: string, label: string): string {
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error(`invalid ${label}`);
  }
  return id;
}

/** 去掉路径分隔与危险字符，保留可读文件名（LIB-029：仅本模块用，不 export） */
function sanitizeFilename(name: string): string {
  const base = basename(name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return base.length > 0 ? base.slice(0, 180) : 'file';
}

function dirFor(sessionId: string, attachmentId: string): string {
  const sid = assertSafeId(sessionId, 'sessionId');
  const aid = assertSafeId(attachmentId, 'attachmentId');
  const dir = resolve(attachmentsRoot(), sid, aid);
  // 双重保险：解析后必须仍在 attachments 根下
  const rel = relative(attachmentsRoot(), dir);
  if (rel.startsWith('..') || rel === '') {
    throw new Error('attachment path escapes root');
  }
  return dir;
}

export function absolutePathFor(
  sessionId: string,
  attachmentId: string,
  filename: string,
): string {
  return join(dirFor(sessionId, attachmentId), sanitizeFilename(filename));
}

export function publicUrlFor(sessionId: string, attachmentId: string): string {
  return `/api/sessions/${sessionId}/attachments/${attachmentId}`;
}

/** 写入新附件；超限抛错 */
export async function saveAttachment(opts: {
  sessionId: string;
  filename: string;
  mediaType: string;
  data: Buffer;
}): Promise<StoredAttachment> {
  if (opts.data.byteLength === 0) {
    throw new Error('empty file');
  }
  if (opts.data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`file exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
  }
  const id = ulid();
  const filename = sanitizeFilename(opts.filename);
  const dir = dirFor(opts.sessionId, id);
  await mkdir(dir, { recursive: true });
  const absPath = join(dir, filename);
  await writeFile(absPath, opts.data);
  return {
    id,
    sessionId: opts.sessionId,
    filename,
    mediaType: opts.mediaType || 'application/octet-stream',
    size: opts.data.byteLength,
    absPath,
    url: publicUrlFor(opts.sessionId, id),
  };
}

/** 读附件元数据：目录下第一个文件（上传时只写一个） */
export async function readAttachmentMeta(
  sessionId: string,
  attachmentId: string,
): Promise<{ absPath: string; filename: string; data: Buffer } | null> {
  const dir = dirFor(sessionId, attachmentId);
  try {
    await access(dir);
  } catch {
    return null;
  }
  const { readdir } = await import('fs/promises');
  const names = await readdir(dir);
  if (names.length === 0) return null;
  const filename = names[0];
  const absPath = join(dir, filename);
  const data = await readFile(absPath);
  return { absPath, filename, data };
}

export async function readAttachmentBuffer(
  sessionId: string,
  attachmentId: string,
): Promise<{ filename: string; data: Buffer } | null> {
  const meta = await readAttachmentMeta(sessionId, attachmentId);
  if (!meta) return null;
  return { filename: meta.filename, data: meta.data };
}
