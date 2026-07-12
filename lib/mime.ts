// APP-016：扩展名 → MIME 映射，供 attachments 等 route 共用（禁止散落硬编码）
export const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/typescript',
  py: 'text/x-python',
  zip: 'application/zip',
};

/** 按文件名后缀解析 MIME；未知回退 octet-stream */
export function mimeFromFilename(filename: string): string {
  const ext = filename.includes('.')
    ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
    : '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}
