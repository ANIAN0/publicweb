import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// 字体：不走 Google 在线下载（内网/墙下 next/font/google 会失败刷屏）。
// 使用系统栈；CSS 变量与原先 --font-geist-* 同名，globals 无需改。
// 若以后要品牌字体，放到 public/fonts 用 next/font/local，禁止再引 google。

export const metadata: Metadata = {
  title: "通用 ChatUI",
  description: "基于 ai-elements 的通用对话前端",
};

// 暗色模式:在 body 内容渲染前同步读取系统偏好,给 <html> 加 .dark class,避免暗色闪烁
const themeScript = `(function(){try{if(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.classList.add('dark');}catch(e){}})()`;

const fontVars = {
  ["--font-geist-sans"]:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  ["--font-geist-mono"]:
    'ui-monospace, "Cascadia Code", "SF Mono", Consolas, "Liberation Mono", monospace',
} as CSSProperties;

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className="h-full antialiased"
      style={fontVars}
    >
      <body className="min-h-full bg-background font-sans text-foreground">
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
        <Toaster />
      </body>
    </html>
  );
}
