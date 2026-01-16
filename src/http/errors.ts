import type { HandlerResult } from '../handlers/http';

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
      traceId,
      error: message,
      errorInfo: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
    },
  };
}
