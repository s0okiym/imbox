export type AuthErrorReason =
  | 'UNAUTHENTICATED'
  | 'TENANT_ACCESS_DENIED'
  | 'CSRF_REJECTED'
  | 'ORIGIN_REJECTED'
  | 'AUTH_METHOD_UNSUPPORTED'
  | 'LOGIN_FAILED'
  | 'NOT_FOUND'
  | 'DEV_AUTH_DISABLED'
  | 'INVALID_REQUEST';
export type AuthErrorCode =
  'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION_FAILED' | 'SERVICE_UNAVAILABLE';

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  constructor(
    readonly reason: AuthErrorReason,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
    this.code =
      statusCode === 503
        ? 'SERVICE_UNAVAILABLE'
        : statusCode === 404
          ? 'NOT_FOUND'
          : statusCode === 400
            ? 'VALIDATION_FAILED'
            : statusCode === 403
              ? 'FORBIDDEN'
              : 'UNAUTHENTICATED';
  }
}
