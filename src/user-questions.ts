import type {
  RuntimeInputAnswers,
  RuntimeInputQuestion,
  RuntimePlanReviewResult,
} from '@canonmsg/agent-sdk';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions';

import { safeDisplayText } from './event-mapping.js';

interface QuestionRoute {
  dshId: string;
  canonId: string;
  optionLabelsByValue: Map<string, string>;
}

export interface CanonQuestionBatch {
  questions: RuntimeInputQuestion[];
  routes: QuestionRoute[];
}

export function planReviewQuestion(
  request: AskUserQuestionRequest,
): AskUserQuestionItem | null {
  if (request.questions.length !== 1) return null;
  const question = request.questions[0];
  return question?.intent?.kind === 'plan-review' ? question : null;
}

export function toCanonQuestionBatch(
  request: AskUserQuestionRequest,
): CanonQuestionBatch {
  const routes: QuestionRoute[] = [];
  const questions = request.questions.map((question, questionIndex): RuntimeInputQuestion => {
    const canonId = canonicalQuestionId(question.id, questionIndex);
    const optionLabelsByValue = new Map<string, string>();
    const choices = question.options?.map((option, optionIndex) => {
      const value = `dsh-option-${questionIndex + 1}-${optionIndex + 1}`;
      optionLabelsByValue.set(value, option.label);
      return {
        label: safeDisplayText(option.label, `Option ${optionIndex + 1}`, 120),
        value,
        ...(option.description
          ? { description: safeDisplayText(option.description, '', 300) }
          : {}),
      };
    });
    routes.push({ dshId: question.id, canonId, optionLabelsByValue });
    const prompt = question.detail
      ? `${question.question}\n\n${question.detail}`
      : question.question;
    return {
      id: canonId,
      question: safeDisplayText(prompt, 'Input requested', 1_000),
      ...(question.header
        ? { header: safeDisplayText(question.header, 'Question', 120) }
        : {}),
      ...(choices?.length ? { choices, allowOther: true } : {}),
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
    };
  });
  return { questions, routes };
}

export function toDshQuestionAnswer(
  batch: CanonQuestionBatch,
  answers: RuntimeInputAnswers | undefined,
): AskUserQuestionAnswer {
  return {
    answers: batch.routes.map((route) => {
      const values = answers?.[route.canonId]?.answers ?? [];
      const selected: string[] = [];
      const custom: string[] = [];
      for (const value of values) {
        const label = route.optionLabelsByValue.get(value);
        if (label !== undefined) selected.push(label);
        else if (value.trim()) custom.push(value.trim());
      }
      return {
        id: route.dshId,
        selected,
        ...(custom.length > 0 ? { custom: custom.join('\n') } : {}),
      };
    }),
  };
}

export function toDshPlanAnswer(
  question: AskUserQuestionItem,
  result: Extract<RuntimePlanReviewResult, { status: 'approve' | 'revise' | 'reject' }>,
): AskUserQuestionAnswer {
  const approve = question.intent?.kind === 'plan-review'
    ? question.intent.approve
    : undefined;
  const decline = question.options?.find((option) => option.label !== approve)?.label;
  if (result.status === 'approve' && approve) {
    return { answers: [{ id: question.id, selected: [approve] }] };
  }
  const feedback = result.feedback?.trim();
  return {
    answers: [{
      id: question.id,
      selected: feedback ? [] : decline ? [decline] : [],
      ...(feedback ? { custom: feedback } : {}),
    }],
  };
}

function canonicalQuestionId(value: string, index: number): string {
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(value)
    ? value
    : `dsh-question-${index + 1}`;
}
