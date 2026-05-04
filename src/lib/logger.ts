import pino, { type Logger } from 'pino';
import { env } from '../config/env.js';

const isDev = env.NODE_ENV === 'development';

/**
 * Dev-mode line format:
 *   [HH:MM:ss.l] DEBUG [TaskWorker task=abc12345 agent=blog-writer event=agent.started] msg key=val
 *
 * The bracket prefix is built from a fixed set of "context" bindings that
 * child loggers and emitLog mirroring populate. We pull those keys out of the
 * JSON tail (via `ignore`) so they only appear in the prefix — no duplication.
 */
const PREFIX_KEYS = ['component', 'taskId', 'agentId', 'event', 'speaker'] as const;
const PREFIX_LABEL: Record<(typeof PREFIX_KEYS)[number], string> = {
  component: '',
  taskId: 'task=',
  agentId: 'agent=',
  event: 'event=',
  speaker: 'by=',
};

function formatPrefix(log: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of PREFIX_KEYS) {
    const v = log[key];
    if (v === undefined || v === null || v === '') continue;
    let str = String(v);
    if (key === 'taskId') str = str.slice(0, 8);
    parts.push(`${PREFIX_LABEL[key]}${str}`);
  }
  return parts.length ? `[${parts.join(' ')}] ` : '';
}

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'auto-ops' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.secret',
      '*.password',
      '*.token',
      '*.apiKey',
      '*.api_key',
    ],
    censor: '[REDACTED]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            singleLine: true,
            ignore: [
              'pid',
              'hostname',
              'service',
              'tenantId',
              'workerId',
              'op',
              ...PREFIX_KEYS,
            ].join(','),
            messageFormat: (log: Record<string, unknown>, messageKey: string) =>
              `${formatPrefix(log)}${log[messageKey] ?? ''}`,
          },
        },
      }
    : {}),
});

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
