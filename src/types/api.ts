/**
 * API-surface types: the stable error envelope shared by every endpoint (brief §13).
 */

/** The only error shape clients ever see: `{ error: { code, message } }`. */
export interface ApiErrorShape {
  error: { code: string; message: string };
}

/** Canonical error codes (brief §13). Not exhaustive — DB-mapped codes are added at the edge. */
export type ApiErrorCode =
  | 'bad_request'
  | 'body_invalid_json'
  | 'missing_field'
  | 'auth_missing'
  | 'auth_invalid'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'conflict'
  | 'upload_too_large'
  | 'unsupported_media_type'
  | 'validation_failed'
  | 'insufficient_privilege'
  | 'pg_auth_failed'
  | 'tenant_db_auth_failed'
  | 'tenant_db_unavailable'
  | 'model_not_configured'
  | 'upstream_error'
  | 'internal_error'
  | 'not_implemented';
