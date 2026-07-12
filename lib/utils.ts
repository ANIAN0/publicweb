import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 Tailwind CSS 类名
 * clsx 处理条件/数组/对象形式的类名输入,twMerge 解决 Tailwind 类冲突(后写的覆盖先写的)
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 相对时间格式化:刚刚 / N 分钟前 / N 小时前 / N 天前 / 具体日期;null → '从未'
// 接受 Date | string(JSON 序列化的 Date) | null,首页列表 + 设备页共用
// LIB-038：locale 可参数覆盖；默认读 WEBTOOL_LOCALE，再回落 zh-CN
export function formatRelative(
  date: Date | string | null,
  locale?: string,
): string {
  if (date === null) return '从未';
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} 天前`;
  const loc =
    locale ||
    (typeof process !== 'undefined' ? process.env.WEBTOOL_LOCALE : undefined) ||
    'zh-CN';
  return d.toLocaleDateString(loc);
}
