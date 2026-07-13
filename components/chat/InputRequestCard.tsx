// HITL 嵌入式回答：单题 eve 形态 + 多题 claude AskUserQuestion 步进
// 多题状态机对标 codex request_user_input：步进 / notes / 进度 / 未答确认
// Esc / 取消 = decision cancel（禁止静默当 allow）
//
// 组件拆分：
//   InputRequestActions - 入口：归一化后按 kind 分发到单/多题变体
//   SingleHitlActions   - 单题 UI：合并步进 + freeform + 选项
//   MultiHitlStepper    - 多题 UI：进度 + 上下题 + 未答确认
//   AnsweredSummary     - 已回答只读摘要（两个变体共用）
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { InputResponse, PersistedPart } from '@/lib/protocol/events';
import { cn } from '@/lib/utils';

// 单题选项
export interface HitlOption {
  id: string;
  label: string;
  description?: string;
  style?: 'danger' | 'default' | 'primary';
}

// 多题中的一题（claude AskUserQuestion）
export interface HitlQuestion {
  id: string;
  question: string;
  options?: ReadonlyArray<HitlOption>;
  // 是否允许 notes / 自由文本
  allowFreeform?: boolean;
  isSecret?: boolean;
}

// 统一 inputRequest：单题（eve）或 questions 数组（claude）
export interface InputRequest {
  requestId: string;
  prompt?: string;
  display?: 'confirmation' | 'select' | 'text';
  options?: ReadonlyArray<HitlOption>;
  allowFreeform?: boolean;
  // 多题：存在时走步进 UI（kind 推断为 multi）
  questions?: ReadonlyArray<HitlQuestion>;
}

export type HitlNormalized = {
  requestId: string;
  kind: 'single' | 'multi';
  questions: HitlQuestion[];
};

// 将 adapter 注入的各种形态规范成可渲染结构
export function normalizeRequest(raw?: InputRequest): HitlNormalized | null {
  if (!raw) return null;
  const requestId = raw.requestId;
  if (raw.questions && raw.questions.length > 0) {
    return {
      requestId,
      kind: raw.questions.length > 1 ? 'multi' : 'single',
      questions: raw.questions.map((q, i) => ({
        id: q.id || `q${i}`,
        question: q.question,
        options: q.options,
        allowFreeform: q.allowFreeform,
        isSecret: q.isSecret,
      })),
    };
  }
  // 单题：合成一题，复用 multi 步进（总数=1 时 UI 更简）
  return {
    requestId,
    kind: 'single',
    questions: [
      {
        id: requestId,
        question: raw.prompt ?? '',
        options: raw.options,
        allowFreeform:
          raw.allowFreeform ||
          raw.display === 'text' ||
          !raw.options ||
          raw.options.length === 0,
      },
    ],
  };
}

// 每题本地答案：选项 id + 可选 notes
type LocalAnswer = { optionId?: string; text?: string };

function readRequestFromPart(part: PersistedPart): {
  raw: InputRequest | undefined;
  inputResponse: InputResponse | undefined;
} {
  const meta = (
    part as {
      toolMetadata?: {
        inputRequest?: InputRequest;
        inputResponse?: InputResponse;
      };
    }
  ).toolMetadata;
  return {
    raw: meta?.inputRequest,
    inputResponse: meta?.inputResponse,
  };
}

interface InputRequestActionsProps {
  part: PersistedPart;
  onRespond: (response: InputResponse) => void;
  canRespond?: boolean;
}

// 入口：归一化后按 kind 显式分发到单/多题变体（消除组件内的 isMulti 分支）
export function InputRequestActions({
  part,
  onRespond,
  canRespond = true,
}: InputRequestActionsProps) {
  const { raw, inputResponse } = readRequestFromPart(part);
  // hooks 必须在 early return 前调用
  const normalized = useMemo(() => normalizeRequest(raw), [raw]);

  if (!raw || !normalized) return null;

  const { requestId, questions, kind } = normalized;

  // 已回答只读：两个变体共用同一摘要
  if (inputResponse) {
    return <AnsweredSummary questions={questions} response={inputResponse} />;
  }

  if (kind === 'multi') {
    return (
      <MultiHitlStepper
        requestId={requestId}
        questions={questions}
        canRespond={canRespond}
        onRespond={onRespond}
      />
    );
  }

  return (
    <SingleHitlActions
      requestId={requestId}
      question={questions[0]}
      canRespond={canRespond}
      onRespond={onRespond}
    />
  );
}

// ============================================================================
// AnsweredSummary - 已回答只读摘要（共享）
// ============================================================================

function AnsweredSummary({
  questions,
  response,
}: {
  questions: HitlQuestion[];
  response: InputResponse;
}) {
  const lines: string[] = [];
  if (response.answers && response.answers.length > 0) {
    for (const a of response.answers) {
      const q = questions.find((qq) => qq.id === a.questionId) ?? questions[0];
      const opt = q?.options?.find((o) => o.id === a.optionId);
      const label = opt?.label ?? a.text ?? a.optionId ?? '已答';
      const secret = q?.isSecret ? '••••••' : label;
      lines.push(q ? `${q.question.slice(0, 40)}${q.question.length > 40 ? '…' : ''} → ${secret}` : secret);
    }
  } else {
    const q = questions[0];
    const opt = q?.options?.find((o) => o.id === response.optionId);
    const label = opt?.label ?? response.text ?? response.optionId ?? '已回答';
    lines.push(q?.isSecret ? '••••••' : label);
  }
  const answered = Math.max(lines.length, response.optionId || response.text ? 1 : 0);

  return (
    <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
      <p className="text-xs font-medium text-muted-foreground">
        已回答 {answered}/{questions.length}
      </p>
      {lines.map((line, i) => (
        <p key={i} className="text-sm font-medium">
          {line}
        </p>
      ))}
    </div>
  );
}

// ============================================================================
// SingleHitlActions - 单题变体（无进度、无上一题、无未答确认）
// ============================================================================

// 仅 id 为 deny/reject 时一键 decision:deny（REV-006-01：禁止用 style:danger 误伤 eve 等其它危险选项）
// adapter 仍对 optionId deny|reject 做第二道归一（T-103）
const isDenyOption = (opt: HitlOption): boolean =>
  opt.id === 'deny' || opt.id === 'reject';

function SingleHitlActions({
  requestId,
  question,
  canRespond,
  onRespond,
}: {
  requestId: string;
  question: HitlQuestion;
  canRespond: boolean;
  onRespond: (r: InputResponse) => void;
}) {
  const [optionId, setOptionId] = useState<string | undefined>();
  const [notes, setNotes] = useState('');

  const showNotes =
    question.allowFreeform ||
    !question.options ||
    question.options.length === 0 ||
    Boolean(optionId);

  const submit = useCallback(() => {
    if (!canRespond) return;
    const t = notes.trim();
    if (optionId) {
      onRespond({
        requestId,
        decision: 'allow',
        optionId,
        ...(t ? { text: t } : {}),
      });
    } else if (t) {
      onRespond({ requestId, decision: 'allow', text: t });
    }
  }, [canRespond, notes, optionId, onRespond, requestId]);

  // Esc = cancel
  const cancel = useCallback(() => {
    if (!canRespond) return;
    onRespond({ requestId, decision: 'cancel' });
  }, [canRespond, onRespond, requestId]);

  useEffect(() => {
    if (!canRespond) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [canRespond, cancel]);

  const selectOption = (id: string) => {
    if (!canRespond) return;
    const opt = question.options?.find((o) => o.id === id);
    // 单题 + deny option → 直接发 decision:deny（REV-005-02）
    if (opt && isDenyOption(opt)) {
      onRespond({ requestId, decision: 'deny', optionId: opt.id });
      return;
    }
    setOptionId(id);
  };

  return (
    <div className="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
      <p className="text-sm text-muted-foreground whitespace-pre-wrap">{question.question}</p>

      {question.options && question.options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {question.options.map((option) => (
            <Button
              key={option.id}
              disabled={!canRespond}
              onClick={() => selectOption(option.id)}
              variant={
                optionId === option.id
                  ? 'default'
                  : option.style === 'danger'
                    ? 'destructive'
                    : 'outline'
              }
              size="sm"
              title={option.description}
              className={cn(optionId === option.id && 'ring-2 ring-ring')}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}

      {showNotes && (
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={!canRespond}
          placeholder={
            question.options && question.options.length > 0
              ? '补充说明（可选）…'
              : question.isSecret
                ? '输入回答…'
                : '输入回答…'
          }
          className="min-h-16 w-full resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
      )}

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!canRespond}
          onClick={cancel}
          title="取消（Esc）"
          className="text-muted-foreground"
        >
          取消
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={
            !canRespond ||
            (!optionId && !notes.trim())
          }
          onClick={submit}
          className="self-end"
        >
          提交
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">Esc 取消 · 不会当作同意</p>
    </div>
  );
}

// ============================================================================
// MultiHitlStepper - 多题变体（步进 + 进度 + 上下题 + 未答确认）
// ============================================================================

function MultiHitlStepper({
  requestId,
  questions,
  canRespond,
  onRespond,
}: {
  requestId: string;
  questions: HitlQuestion[];
  canRespond: boolean;
  onRespond: (r: InputResponse) => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, LocalAnswer>>({});
  const [notes, setNotes] = useState('');
  const [confirmUnanswered, setConfirmUnanswered] = useState(false);

  const q = questions[index];
  const current = answers[q.id] ?? {};
  const selectedOptionId = current.optionId;
  const showNotes =
    q.allowFreeform || !q.options || q.options.length === 0 || Boolean(selectedOptionId);

  const answeredCount = questions.filter((qq) => {
    const a = answers[qq.id];
    return Boolean(a?.optionId || (a?.text && a.text.trim()));
  }).length;

  const unansweredCount = questions.length - answeredCount;

  const patchAnswer = (patch: LocalAnswer) => {
    setAnswers((prev) => ({
      ...prev,
      [q.id]: { ...prev[q.id], ...patch },
    }));
  };

  const selectOption = (optionId: string) => {
    if (!canRespond) return;
    patchAnswer({ optionId });
    setNotes(answers[q.id]?.text ?? '');
  };

  const commitNotesToAnswer = () => {
    const t = notes.trim();
    if (t) patchAnswer({ text: t });
    else if (answers[q.id]?.text) {
      setAnswers((prev) => {
        const next = { ...prev[q.id] };
        delete next.text;
        return { ...prev, [q.id]: next };
      });
    }
  };

  const goNext = () => {
    commitNotesToAnswer();
    const t = notes.trim();
    const nextAnswers = {
      ...answers,
      [q.id]: {
        ...answers[q.id],
        ...(t ? { text: t } : {}),
        ...(selectedOptionId ? { optionId: selectedOptionId } : {}),
      },
    };
    setAnswers(nextAnswers);
    setNotes('');
    if (index < questions.length - 1) {
      setIndex(index + 1);
      const nq = questions[index + 1];
      setNotes(nextAnswers[nq.id]?.text ?? '');
      return;
    }
    // 最后一题：检查未答
    const missing = questions.filter((qq) => {
      const a = nextAnswers[qq.id];
      return !(a?.optionId || (a?.text && a.text.trim()));
    });
    if (missing.length > 0) {
      setConfirmUnanswered(true);
      return;
    }
    submitAll(nextAnswers);
  };

  const submitAll = (finalAnswers: Record<string, LocalAnswer>) => {
    if (!canRespond) return;
    setConfirmUnanswered(false);
    // 多题：answers 数组 + decision allow
    const answersList = questions.map((qq) => ({
      questionId: qq.id,
      optionId: finalAnswers[qq.id]?.optionId,
      text: finalAnswers[qq.id]?.text,
    }));
    const summary = answersList
      .map((a) => a.text || a.optionId || '')
      .filter(Boolean)
      .join('; ');
    onRespond({
      requestId,
      decision: 'allow',
      text: summary || JSON.stringify(answersList),
      answers: answersList,
    });
  };

  // Esc = cancel（codex：elicitation Esc 不可静默批准）
  const cancelHitl = useCallback(() => {
    if (!canRespond) return;
    onRespond({ requestId, decision: 'cancel' });
  }, [canRespond, onRespond, requestId]);

  useEffect(() => {
    if (!canRespond) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelHitl();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [canRespond, cancelHitl]);

  if (confirmUnanswered) {
    return (
      <div className="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
        <p className="text-sm font-medium">仍有 {unansweredCount} 题未答，确认提交？</p>
        <p className="text-xs text-muted-foreground">可返回第一道未答题，或带空答案继续。</p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              // 跳到第一道未答题
              const idx = questions.findIndex((qq) => {
                const a = answers[qq.id];
                return !(a?.optionId || (a?.text && a.text.trim()));
              });
              setIndex(idx >= 0 ? idx : 0);
              setConfirmUnanswered(false);
              setNotes(answers[questions[idx >= 0 ? idx : 0]?.id]?.text ?? '');
            }}
          >
            返回未答
          </Button>
          <Button
            size="sm"
            variant="default"
            onClick={() => {
              commitNotesToAnswer();
              const t = notes.trim();
              const nextAnswers = {
                ...answers,
                [q.id]: {
                  ...answers[q.id],
                  ...(t ? { text: t } : {}),
                  ...(selectedOptionId ? { optionId: selectedOptionId } : {}),
                },
              };
              submitAll(nextAnswers);
            }}
          >
            仍要提交
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
      {/* 进度 */}
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          问题 {index + 1}/{questions.length}
        </span>
        <span>
          已答 {answeredCount}/{questions.length}
        </span>
      </div>
      <p className="text-sm text-muted-foreground whitespace-pre-wrap">{q.question}</p>

      {q.options && q.options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {q.options.map((option) => (
            <Button
              key={option.id}
              disabled={!canRespond}
              onClick={() => selectOption(option.id)}
              variant={
                selectedOptionId === option.id
                  ? 'default'
                  : option.style === 'danger'
                    ? 'destructive'
                    : 'outline'
              }
              size="sm"
              title={option.description}
              className={cn(selectedOptionId === option.id && 'ring-2 ring-ring')}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}

      {showNotes && (
        <div className="flex flex-col gap-2">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={!canRespond}
            placeholder={
              q.options && q.options.length > 0
                ? '补充说明（可选）…'
                : q.isSecret
                  ? '输入回答…'
                  : '输入回答…'
            }
            className="min-h-16 w-full resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                goNext();
              }
            }}
          />
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {index > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!canRespond}
              onClick={() => {
                commitNotesToAnswer();
                const t = notes.trim();
                setAnswers((prev) => ({
                  ...prev,
                  [q.id]: {
                    ...prev[q.id],
                    ...(t ? { text: t } : {}),
                    ...(selectedOptionId ? { optionId: selectedOptionId } : {}),
                  },
                }));
                const prevIdx = index - 1;
                setIndex(prevIdx);
                setNotes(answers[questions[prevIdx].id]?.text ?? '');
              }}
            >
              上一题
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!canRespond}
            onClick={cancelHitl}
            title="取消（Esc）"
            className="text-muted-foreground"
          >
            取消
          </Button>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={
            !canRespond ||
            // 无选项且无 notes 时禁止下一步（单 freeform 必填）
            ((!q.options || q.options.length === 0) && !notes.trim() && !current.text)
          }
          onClick={goNext}
          className="self-end"
        >
          {index < questions.length - 1 ? '下一题' : '提交'}
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">Esc 取消 · 不会当作同意</p>
    </div>
  );
}
