// 工具展示元数据：icon 名 + input 一行 hint + 人类可读名
// 对标 json-render TOOL_META / paseo humanizeToolName / DEEIX tool-trace 摘要
import type { LucideIcon } from 'lucide-react';
import {
  FileSearch,
  FileText,
  FilePenLine,
  Terminal,
  Globe,
  Search,
  Wrench,
  FolderOpen,
  ListTodo,
  MessageCircleQuestion,
} from 'lucide-react';

export type ToolCategory = 'searched' | 'read' | 'wrote' | 'ran' | 'other';

// leaf name：mcp__x__y → y；namespace 保留展示用
export function getToolLeafName(toolName: string): string {
  if (!toolName) return '';
  const mcp = toolName.match(/^mcp__[^_]+__(.+)$/i);
  if (mcp) return mcp[1];
  const parts = toolName.split(/[/:]/);
  return parts[parts.length - 1] || toolName;
}

// PascalCase / snake_case / kebab → 可读标题
export function humanizeToolName(toolName: string): string {
  const leaf = getToolLeafName(toolName);
  if (!leaf) return toolName || 'Tool';
  // 已是空格分隔的保留
  if (/\s/.test(leaf)) return leaf;
  // snake / kebab
  if (/[_-]/.test(leaf)) {
    return leaf
      .split(/[_-]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }
  // PascalCase / camelCase
  const spaced = leaf
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return spaced
    .split(/\s+/)
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

// LIB-033：类别匹配规则单一数据源，供 inferToolCategory / toolIconFor 复用
const CATEGORY_RULES: Array<{ cat: ToolCategory; re: RegExp }> = [
  { cat: 'searched', re: /grep|search|find|glob|rg\b/ },
  { cat: 'read', re: /^read|^cat|^head|^tail|view|open/ },
  { cat: 'wrote', re: /write|edit|patch|append|create|mkdir|^rm$|^mv$|apply_patch/ },
  { cat: 'ran', re: /bash|run|exec|^sh$|shell|terminal/ },
];

export function inferToolCategory(toolName: string): ToolCategory {
  const n = getToolLeafName(toolName).toLowerCase();
  for (const { cat, re } of CATEGORY_RULES) {
    if (re.test(n)) return cat;
  }
  return 'other';
}

// LIB-034：hint 字段优先级表 + 解析扁平化，减少深层嵌套
const HINT_KEYS = [
  'command',
  'cmd',
  'file_path',
  'filePath',
  'path',
  'pattern',
  'query',
  'url',
  'prompt',
  'description',
] as const;

/** 把 tool input 规范为对象；无法解析则返回 null，字符串原文放 raw */
function coerceToolInput(input: unknown): { obj: Record<string, unknown> | null; raw?: string } {
  if (input == null) return { obj: null };
  if (typeof input === 'string') {
    const t = input.trim();
    if (!t) return { obj: null };
    try {
      const parsed = JSON.parse(t) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { obj: parsed as Record<string, unknown> };
      }
      return { obj: null, raw: t };
    } catch {
      return { obj: null, raw: t };
    }
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    return { obj: input as Record<string, unknown> };
  }
  return { obj: null };
}

// 从 tool input 抽一行 hint（command / path / pattern / query）
export function toolInputHint(_toolName: string, input: unknown): string {
  const { obj, raw } = coerceToolInput(input);
  if (raw) return truncateHint(raw, 80);
  if (!obj) return '';
  for (const k of HINT_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return truncateHint(v.trim(), 80);
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.trim() && v.length < 200) {
      return truncateHint(v.trim(), 80);
    }
  }
  return '';
}

function truncateHint(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

// 按类别选图标
export function toolIconFor(toolName: string): LucideIcon {
  const n = getToolLeafName(toolName).toLowerCase();
  if (/ask|question|input|confirm/.test(n)) return MessageCircleQuestion;
  if (/web|fetch|http|url|browser/.test(n)) return Globe;
  if (/grep|search|find|glob/.test(n)) return Search;
  if (/read|cat|view|head|tail/.test(n)) return FileText;
  if (/write|edit|patch|create|apply/.test(n)) return FilePenLine;
  if (/bash|run|exec|shell|sh\b|terminal/.test(n)) return Terminal;
  if (/ls|dir|glob|folder|list_dir/.test(n)) return FolderOpen;
  if (/todo|plan|task/.test(n)) return ListTodo;
  if (/file|path/.test(n)) return FileSearch;
  return Wrench;
}

// 判断文本是否应默认折叠（DEEIX：>8 行或 >420 字）
export const TOOL_DETAIL_COLLAPSE_LINES = 8;
export const TOOL_DETAIL_COLLAPSE_CHARS = 420;

export function shouldCollapseToolDetail(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return t.split(/\r?\n/).length > TOOL_DETAIL_COLLAPSE_LINES || t.length > TOOL_DETAIL_COLLAPSE_CHARS;
}

export function formatToolPayload(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return '';
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      return value;
    }
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

// 从 errorText / output 抽短 errorMeta（如 exit 1）
export function extractErrorMeta(errorText?: string | null, output?: unknown): string | undefined {
  const src =
    (typeof errorText === 'string' && errorText) ||
    (typeof output === 'string' && output) ||
    '';
  if (!src) return undefined;
  const exit = src.match(/\bexit(?:\s+code)?[:\s]+(\d+)\b/i);
  if (exit) return `exit ${exit[1]}`;
  const status = src.match(/\bstatus[:\s]+(\d+)\b/i);
  if (status) return `status ${status[1]}`;
  // 首行短错误
  const first = src.split(/\r?\n/).find((l) => l.trim())?.trim();
  if (first && first.length <= 40) return first;
  return undefined;
}
