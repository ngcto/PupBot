export class ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { code?: string; retryable?: boolean; status?: number } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = options.code ?? "provider_error";
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

export class UnsupportedEndpointError extends ProviderError {
  constructor(kind: string) {
    super(`The ${kind} endpoint kind is not wired yet.`, { code: "unsupported_endpoint" });
    this.name = "UnsupportedEndpointError";
  }
}
