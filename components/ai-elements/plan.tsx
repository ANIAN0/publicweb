"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronsUpDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, use, useMemo } from "react";

import { Shimmer } from "./shimmer";

// state / actions / meta 三段式：未来要替换状态来源（URL/Store/Server）
// 时只需注入同形 Context，子组件无需改动。
interface PlanState {
  isStreaming: boolean;
}
interface PlanActions {
  // 当前 Plan 没有 action 暴露给子组件，预留以备扩展
  __placeholder?: never;
}
interface PlanMeta {
  // 当前没有 ref / 外部资源依赖
  __placeholder?: never;
}
interface PlanContextValue {
  state: PlanState;
  actions: PlanActions;
  meta: PlanMeta;
}

const PlanContext = createContext<PlanContextValue | null>(null);

const usePlan = () => {
  const context = use(PlanContext);
  if (!context) {
    throw new Error("Plan components must be used within Plan");
  }
  return context;
};

export type PlanProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
};

export const Plan = ({
  className,
  isStreaming = false,
  children,
  ...props
}: PlanProps) => {
  const contextValue = useMemo<PlanContextValue>(
    () => ({
      actions: {},
      meta: {},
      state: { isStreaming },
    }),
    [isStreaming],
  );

  return (
    <PlanContext.Provider value={contextValue}>
      <Collapsible data-slot="plan" {...props} render={<Card className={cn("shadow-none", className)} />}>{children}</Collapsible>
    </PlanContext.Provider>
  );
};

export type PlanHeaderProps = ComponentProps<typeof CardHeader>;

export const PlanHeader = ({ className, ...props }: PlanHeaderProps) => (
  <CardHeader
    className={cn("flex items-start justify-between", className)}
    data-slot="plan-header"
    {...props}
  />
);

export type PlanTitleProps = Omit<
  ComponentProps<typeof CardTitle>,
  "children"
> & {
  children: string;
};

export const PlanTitle = ({ children, ...props }: PlanTitleProps) => {
  const {
    state: { isStreaming },
  } = usePlan();

  return (
    <CardTitle data-slot="plan-title" {...props}>
      {isStreaming ? <Shimmer>{children}</Shimmer> : children}
    </CardTitle>
  );
};

export type PlanDescriptionProps = Omit<
  ComponentProps<typeof CardDescription>,
  "children"
> & {
  children: string;
};

export const PlanDescription = ({
  className,
  children,
  ...props
}: PlanDescriptionProps) => {
  const {
    state: { isStreaming },
  } = usePlan();

  return (
    <CardDescription
      className={cn("text-balance", className)}
      data-slot="plan-description"
      {...props}
    >
      {/* Shimmer 默认渲染为 <p>，而 CardDescription 本身是 <p>，嵌套会触发 validateDOMNesting + 水合错误；改为 <span> */}
      {isStreaming ? <Shimmer as="span">{children}</Shimmer> : children}
    </CardDescription>
  );
};

export type PlanActionProps = ComponentProps<typeof CardAction>;

export const PlanAction = (props: PlanActionProps) => (
  <CardAction data-slot="plan-action" {...props} />
);

export type PlanContentProps = ComponentProps<typeof CardContent>;

export const PlanContent = (props: PlanContentProps) => (
  <CollapsibleContent render={<CardContent data-slot="plan-content" {...props} />}></CollapsibleContent>
);

export type PlanFooterProps = ComponentProps<"div">;

export const PlanFooter = (props: PlanFooterProps) => (
  <CardFooter data-slot="plan-footer" {...props} />
);

export type PlanTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  /**
   * 自定义图标。缺省为 ChevronsUpDownIcon。
   * 通过 children 覆盖可以让调用方选择不同的视觉或加动画。
   */
  children?: ReactNode;
};

export const PlanTrigger = ({ className, children, ...props }: PlanTriggerProps) => (
  <CollapsibleTrigger
    {...props}
    render={
      <Button
        className={cn("size-8", className)}
        data-slot="plan-trigger"
        size="icon"
        variant="ghost"
      />
    }
  >
    {children ?? <ChevronsUpDownIcon className="size-4" />}
    <span className="sr-only">Toggle plan</span>
  </CollapsibleTrigger>
);
