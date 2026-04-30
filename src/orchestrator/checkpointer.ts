import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { env } from '../config/env.js';

/**
 * LangGraph Postgres checkpointer.
 *
 * Stored in a separate `checkpoints` schema/table managed by PostgresSaver itself.
 * Thread id == task id, so loading the checkpoint for a task resumes execution
 * exactly where it was paused (e.g. after a Waiting → Approve transition).
 */
let saver: PostgresSaver | null = null;

export async function getCheckpointer(): Promise<PostgresSaver> {
  if (saver) return saver;
  saver = PostgresSaver.fromConnString(env.DATABASE_URL);
  await saver.setup();
  return saver;
}
