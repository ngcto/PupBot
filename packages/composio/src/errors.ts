export type ComposioErrorCode =
  | "not_configured"
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "invalid_request"
  | "upstream"
  | "network"
  | "timeout";

/**
 * The one error type callers see. It never carries the project API key: the
 * message comes from the response body, and the request that produced it is
 * never part of the string, so a thrown error is safe to log.
 */
export class ComposioError extends Error {
  readonly code: ComposioErrorCode;
  readonly status: number | undefined;
  readonly detail: string | undefined;

  constructor(code: ComposioErrorCode, message: string, options: { status?: number; detail?: string } = {}) {
    super(message);
    this.name = "ComposioError";
    this.code = code;
    this.status = options.status;
    this.detail = options.detail;
  }
}

export function errorCodeForStatus(status: number): ComposioErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 400 && status < 500) return "invalid_request";
  return "upstream";
}
