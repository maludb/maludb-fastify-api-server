/**
 * API request log (brief §11). One line per request — method, path, status, duration, user,
 * token prefix, error code — plus the stack trace for server-side 500s (logged here only, never
 * sent to the client).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { apiLogPath } from '../config/paths.js';
import { isoNowMs } from './sql-log.js';

let dirReady = false;
function appendSafe(path: string, text: string): void {
  try {
    if (!dirReady) {
      mkdirSync(dirname(path), { recursive: true });
      dirReady = true;
    }
    appendFileSync(path, text);
  } catch {
    // Logging must never break a request.
  }
}

/** Write one api.log line (and an optional stack block for 500s). */
export function apiLog(o: {
  method: string;
  path: string;
  status: number;
  durMs: number;
  user: string | number;
  tokenPrefix?: string | null;
  errorCode?: string | null;
  stack?: string | null;
}): void {
  let line =
    `${isoNowMs()}  ${o.method}  ${o.path}  ${o.status}  ${o.durMs.toFixed(1)}ms  ` +
    `user=${o.user}  token=${o.tokenPrefix ?? '-'}  code=${o.errorCode ?? '-'}\n`;
  if (o.stack) line += o.stack + '\n';
  appendSafe(apiLogPath(), line);
}
