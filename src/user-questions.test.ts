import { describe, expect, it } from 'vitest';

import {
  planReviewQuestion,
  toCanonQuestionBatch,
  toDshPlanAnswer,
  toDshQuestionAnswer,
} from './user-questions.js';

describe('DSH user-question mapping', () => {
  it('round-trips selected options and custom answers without trusting DSH ids as Canon ids', () => {
    const request = {
      questions: [
        {
          id: 'not a Canon id',
          header: 'Approach',
          question: 'Which approach?',
          detail: 'Choose the smallest safe change.',
          options: [
            { label: 'Small patch', description: 'Minimal surface.' },
            { label: 'Refactor', description: 'Broader cleanup.' },
          ],
          multiSelect: true,
        },
        { id: 'notes', question: 'Anything else?' },
      ],
    };
    const batch = toCanonQuestionBatch(request);

    expect(batch.questions).toEqual([
      expect.objectContaining({
        id: 'dsh-question-1',
        header: 'Approach',
        question: 'Which approach? Choose the smallest safe change.',
        allowOther: true,
        multiSelect: true,
        choices: [
          expect.objectContaining({ label: 'Small patch', value: 'dsh-option-1-1' }),
          expect.objectContaining({ label: 'Refactor', value: 'dsh-option-1-2' }),
        ],
      }),
      expect.objectContaining({ id: 'notes', question: 'Anything else?' }),
    ]);
    expect(toDshQuestionAnswer(batch, {
      'dsh-question-1': { answers: ['dsh-option-1-1', 'A custom constraint'] },
      notes: { answers: ['Keep it tight'] },
    })).toEqual({
      answers: [
        { id: 'not a Canon id', selected: ['Small patch'], custom: 'A custom constraint' },
        { id: 'notes', selected: [], custom: 'Keep it tight' },
      ],
    });
  });

  it('recognizes DSH plan-review intent and maps Canon decisions back to its vocabulary', () => {
    const request = {
      questions: [{
        id: 'plan-review',
        question: 'Approve this plan?',
        detail: '# Plan',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review' as const, approve: 'Approve' },
      }],
    };
    const question = planReviewQuestion(request);
    if (!question) throw new Error('expected plan review');

    expect(toDshPlanAnswer(question, { status: 'approve', planId: 'plan-1' }))
      .toEqual({ answers: [{ id: 'plan-review', selected: ['Approve'] }] });
    expect(toDshPlanAnswer(question, {
      status: 'revise',
      planId: 'plan-1',
      feedback: 'Add rollback steps.',
    })).toEqual({
      answers: [{ id: 'plan-review', selected: [], custom: 'Add rollback steps.' }],
    });
    expect(toDshPlanAnswer(question, { status: 'reject', planId: 'plan-1' }))
      .toEqual({ answers: [{ id: 'plan-review', selected: ['Keep planning'] }] });
  });
});
