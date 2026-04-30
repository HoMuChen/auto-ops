import pino, { type Logger } from 'pino';
import { env } from '../config/env.js';

const isDev = env.NODE_ENV === 'development';

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
            ignore: 'pid,hostname,service',
          },
        },
      }
    : {}),
});

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
