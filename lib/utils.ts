import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 Tailwind CSS 类名
 * clsx 处理条件/数组/对象形式的类名输入,twMerge 解决 Tailwind 类冲突(后写的覆盖先写的)
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
