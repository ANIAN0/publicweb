'use client';

// 轻量 Checkbox：原生 input + 可见方框，避免为批量删除再引入第三方 checkbox 包
import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

// React 19: ref 作为普通 prop，无需 forwardRef 包装
export function Checkbox({
  className,
  checked,
  onCheckedChange,
  disabled,
  id,
  ref,
  ...props
}: CheckboxProps & { ref?: React.Ref<HTMLInputElement> }) {
  return (
    <label
      className={cn(
        'relative inline-flex size-4 shrink-0 cursor-pointer items-center justify-center',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <input
        ref={ref}
        id={id}
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
        {...props}
      />
      <span
        className={cn(
          'flex size-4 items-center justify-center rounded-[4px] border border-input bg-background shadow-xs transition-colors',
          'peer-focus-visible:border-ring peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50',
          'peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground',
        )}
        aria-hidden
      >
        {checked ? <Check className="size-3" strokeWidth={3} /> : null}
      </span>
    </label>
  );
}
