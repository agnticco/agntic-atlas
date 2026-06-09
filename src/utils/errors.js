/**
 * Structured error types for consistent API responses.
 *
 * Every error carries a `code` (machine-readable) and `status` (HTTP status).
 * The server's catch blocks use `toJSON()` to produce a uniform envelope:
 *   { error: { code, message } }
 *
 * @module src/utils/errors.js
 */

export class AppError extends Error {
  constructor(message, { code = 'internal_error', status = 500 } = {}) {
    super(message);
    this.code   = code;
    this.status = status;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message } };
  }
}

export class ValidationError extends AppError {
  constructor(message) {
    super(message, { code: 'validation_error', status: 400 });
  }
}

export class AuthError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, { code: 'auth_error', status: 401 });
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Rate limit exceeded. Try again shortly.') {
    super(message, { code: 'rate_limit_error', status: 429 });
  }
}

export class CapacityError extends AppError {
  constructor(message = 'Server at session capacity. Try again later.') {
    super(message, { code: 'capacity_error', status: 503 });
  }
}

/**
 * Express error-response helper. Handles both AppError and generic Error.
 */
export function sendError(res, err) {
  if (err instanceof AppError) {
    return res.status(err.status).json(err.toJSON());
  }
  return res.status(500).json({ error: { code: 'internal_error', message: err.message } });
}
