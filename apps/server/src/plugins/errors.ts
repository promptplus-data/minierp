import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';

interface PgError { code?: string; constraint?: string; message: string }
const isPg = (e: unknown): e is PgError => typeof e === 'object' && e !== null && typeof (e as PgError).code === 'string' && /^[0-9A-Z]{5}$/.test((e as PgError).code!);

/** Maps every error to the ApiError body { code, message, details? }. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ code: 'VALIDATION', message: 'Invalid request', details: err.issues });
    }
    const fe = err as FastifyError;
    if (fe.code?.startsWith('FST_JWT') || fe.code === 'FST_JWT_NO_AUTHORIZATION_IN_HEADER') {
      return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Not signed in or session expired' });
    }
    if (fe.validation || fe.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || fe.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || (fe.statusCode === 400 && fe.code?.startsWith('FST_'))) {
      return reply.status(400).send({ code: 'VALIDATION', message: fe.message });
    }
    const pgErr: unknown = err;
    if (isPg(pgErr)) {
      // Last lines of defence in the database.
      if (pgErr.code === '23514' && pgErr.constraint === 'stock_lots_remaining_nonneg') {
        return reply.status(409).send({ code: 'INSUFFICIENT_STOCK', message: 'Insufficient stock (BR-07)', details: [] });
      }
      if (pgErr.code === '23505') return reply.status(409).send({ code: 'CONFLICT', message: 'Duplicate value', details: { constraint: pgErr.constraint } });
      if (pgErr.code === '40P01' || pgErr.code === '40001') return reply.status(409).send({ code: 'CONFLICT', message: 'Concurrent update, please retry' });
      if (pgErr.code === '23001' || pgErr.code === '42501') return reply.status(409).send({ code: 'CONFLICT', message: 'Operation not allowed on this record' });
      if (pgErr.code === '22P02') return reply.status(400).send({ code: 'VALIDATION', message: 'Malformed identifier or number' });
    }
    if (fe.statusCode === 404) return reply.status(404).send({ code: 'NOT_FOUND', message: fe.message });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ code: 'INTERNAL', message: 'Internal error' });
  });
}
