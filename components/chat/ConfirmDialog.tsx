'use client';

// 二次确认对话框：危险操作前的最后一道防线（删除/退出等）
// 用法：<ConfirmDialog open={...} title="..." message="..." onConfirm={...} onCancel={...} />
import { useEffect, useRef } from 'react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;        // 默认 "确认"
  cancelText?: string;         // 默认 "取消"
  destructive?: boolean;       // 红色强调（默认 false）
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // 自动聚焦确认按钮（避免 Enter 误触取消）；Esc 取消
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="bg-white dark:bg-zinc-900 rounded-lg shadow-lg max-w-sm w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-2">{title}</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm border rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            {cancelText}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`px-4 py-2 text-sm text-white rounded ${
              destructive
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-blue-500 hover:bg-blue-600'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}