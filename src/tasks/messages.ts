import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Message, type MessageRole, messages } from '../db/schema/index.js';

export async function appendMessage(input: {
  tenantId: string;
  taskId: string;
  role: MessageRole;
  content: string;
  agentKey?: string;
  data?: Record<string, unknown>;
  createdBy?: string;
}): Promise<Message> {
  const [msg] = await db.insert(messages).values(input).returning();
  if (!msg) throw new Error('Failed to append message');
  return msg;
}

export async function listMessages(tenantId: string, taskId: string): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.tenantId, tenantId), eq(messages.taskId, taskId)))
    .orderBy(asc(messages.createdAt));
}
