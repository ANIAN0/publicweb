// sonner Toast 封装：全站短暂反馈（复制成功 / 保存失败等）
'use client';

import { Toaster as SonnerToaster } from 'sonner';

export function Toaster() {
  return (
    <SonnerToaster
      position="top-center"
      richColors
      closeButton
      // 与 shadcn 语义 token 对齐
      toastOptions={{
        classNames: {
          toast: 'border-border bg-background text-foreground shadow-md',
          description: 'text-muted-foreground',
        },
      }}
    />
  );
}
