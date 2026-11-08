import { pino, type Logger } from 'pino';

export function createLogger(name: string, level: string, pretty: boolean): Logger {
  return pino({
    name,
    level,
    // The OANDA token must never reach a log line (spec 0002, AC-9).
    redact: {
      paths: ['token', '*.token', 'headers.authorization', '*.headers.authorization', 'OANDA_API_TOKEN', '*.OANDA_API_TOKEN'],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}
