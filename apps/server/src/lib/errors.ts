import type { ApiError } from '@erp/contracts';

export type ApiErrorCode = ApiError['code'];

/** Thrown by services; mapped 1:1 to the ApiError body by the error handler. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const E = {
  validation: (message: string, details?: unknown) => new AppError(400, 'VALIDATION', message, details),
  unauthorized: (message = 'Not signed in', details?: unknown) => new AppError(401, 'UNAUTHORIZED', message, details),
  forbidden: (message: string, details?: unknown) => new AppError(403, 'FORBIDDEN', message, details),
  notFound: (message: string, details?: unknown) => new AppError(404, 'NOT_FOUND', message, details),
  conflict: (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details),
  belowCost: (message: string, details: unknown) => new AppError(409, 'BELOW_COST', message, details),
  insufficientStock: (details: unknown) => new AppError(409, 'INSUFFICIENT_STOCK', 'Insufficient stock (BR-07: stock never goes negative)', details),
  shiftRequired: (message = 'An open shift owned by you is required (BR-20)') => new AppError(409, 'SHIFT_REQUIRED', message),
  downstreamFirst: (message: string, details?: unknown) => new AppError(409, 'DOWNSTREAM_FIRST', message, details),
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);
