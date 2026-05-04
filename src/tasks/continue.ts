import type { Task } from '../db/schema/index.js';
import { IllegalStateError } from '../lib/errors.js';
import { readTaskOutput } from './output.js';

export interface ContinuationContext {
  /** The brief the LLM (and message log) actually sees — prior report + follow-up. */
  synthesizedBrief: string;
  /** Markdown report extracted from the prior task; useful for params traceability. */
  priorReport: string;
}

/**
 * Synthesize the seed message for a continuation task. The supervisor and
 * downstream agents only read the conversation history, so we inline the
 * prior task's artifact.report as context above the user's follow-up brief.
 *
 * Throws when the prior task is not in a state suitable for continuation —
 * must be `done` and must have produced a `report` artifact.
 */
export function buildContinuation(priorTask: Task, followUpBrief: string): ContinuationContext {
  if (priorTask.status !== 'done') {
    throw new IllegalStateError(
      `Cannot continue from task ${priorTask.id}: status is ${priorTask.status}, expected done`,
    );
  }
  const output = readTaskOutput(priorTask);
  const report = output.artifact?.report;
  if (!report) {
    throw new IllegalStateError(
      `Cannot continue from task ${priorTask.id}: prior task has no artifact.report to thread forward`,
    );
  }

  const synthesizedBrief = `（接續自先前任務 ${priorTask.id}）

## 先前任務的產出（作為脈絡）

${report}

---

請接著處理：${followUpBrief}`;

  return { synthesizedBrief, priorReport: report };
}
