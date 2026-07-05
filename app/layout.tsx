import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// Geist 字体:正文用 Sans,代码用 Mono,变量挂到 --font-geist-sans / --font-geist-mono
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "通用 ChatUI",
  description: "基于 ai-elements 的通用对话前端",
};

// 暗色模式:在 body 内容渲染前同步读取系统偏好,给 <html> 加 .dark class,避免暗色闪烁
// 后续若加主题切换器,把用户选择写入 localStorage 并在此读取覆盖系统偏好即可
const themeScript = `(function(){try{if(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.classList.add('dark');}catch(e){}})()`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-background text-foreground">
        {/* 暗色跟随系统脚本:须在 children 渲染前同步执行 */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
      </body>
    </html>
  );
}
