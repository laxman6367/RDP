export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message?: string,
    readonly details?: unknown,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code: string, message?: string, details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = (code = 'UNAUTHORIZED', message?: string) => new HttpError(401, code, message);
export const forbidden = (code = 'FORBIDDEN', message?: string) => new HttpError(403, code, message);
export const notFound = (what = 'resource') => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message?: string) => new HttpError(409, code, message);
