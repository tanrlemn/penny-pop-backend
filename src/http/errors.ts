import type { HandlerResult } from '../handlers/http';
import { API_VERSION } from './version';

export type ErrorPayload = {
  code: string;
  message: string;
  traceId: string;
  details?: unknown;
};

export function errorResponse(payload: ErrorPayload, httpStatus: number): HandlerResult {
  const { code, message, traceId, details } = payload;
  return {
    status: httpStatus,
    json: {
      apiVersion: API_VERSION,
      traceId,
      code,
      error: message,
      errorInfo: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
    },
  };
}
