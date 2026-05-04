import { markdownToHtml } from '../agents/lib/markdown.js';
import { env } from '../config/env.js';
import type { Task } from '../db/schema/index.js';
import { readTaskOutput } from '../tasks/output.js';

export interface DoneEmailContent {
  subject: string;
  text: string;
  html: string;
}

/**
 * Compose the subject + text/html bodies for a "task done" email.
 *
 * The artifact.report (markdown) is included in the body so the recipient
 * gets the full deliverable in their inbox, not just a notification ping.
 * When APP_BASE_URL is set, a clickable task-link is added at the top.
 */
export function buildDoneEmail(task: Task): DoneEmailContent {
  const output = readTaskOutput(task);
  const report = output.artifact?.report?.trim();
  const link = env.APP_BASE_URL ? `${env.APP_BASE_URL.replace(/\/$/, '')}/tasks/${task.id}` : null;

  const subject = `✓ ${task.title}`.slice(0, 200);

  const linkLine = link ? `查看完整任務：${link}` : '';
  const reportBlock = report ? `\n\n${report}` : '\n\n（這個任務沒有產出 report 內容。）';
  const text = `任務「${task.title}」已完成。${linkLine ? `\n${linkLine}` : ''}${reportBlock}`;

  const linkHtml = link
    ? `<p><a href="${escapeHtml(link)}">查看完整任務</a></p>`
    : '';
  // Render markdown to HTML via the same helper Shopify publishing uses.
  // Trusted source — output is from our own agents, no need to sanitise here
  // (Gmail / Outlook strip dangerous tags client-side anyway). Title is still
  // escaped because it's a string field embedded in a non-markdown wrapper.
  const reportHtml = report
    ? markdownToHtml(report)
    : '<p>（這個任務沒有產出 report 內容。）</p>';
  const html = `<div style="font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.5;">
<p>任務「<strong>${escapeHtml(task.title)}</strong>」已完成。</p>
${linkHtml}
${reportHtml}
</div>`;

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
