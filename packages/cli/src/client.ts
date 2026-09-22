export class CliInputError extends Error {
  override readonly name = "CliInputError";
  readonly details: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.details = details;
  }
}

export class CliConfigError extends Error {
  override readonly name = "CliConfigError";
  readonly details: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.details = details;
  }
}

export class TransportError extends Error {
  override readonly name = "TransportError";
  readonly url: string;
  override readonly cause: unknown;
  constructor(url: URL, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`request failed: ${message}`);
    this.url = url.toString();
    this.cause = cause;
  }
}

// The server answers errors as { error: code, message, currentRevision? }.
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  readonly code: string | undefined;
  readonly details: unknown;
  constructor(
    status: number,
    code: string | undefined,
    message: string,
    details: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ClientOptions {
  readonly remoteUrl: string;
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export const request = async (
  options: ClientOptions,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  params?: Readonly<Record<string, string | number>>,
): Promise<unknown> => {
  const url = new URL(path, options.remoteUrl);
  for (const [key, value] of Object.entries(params ?? {}))
    url.searchParams.set(key, String(value));

  const headers: Record<string, string> = {};
  if (options.token !== undefined)
    headers.authorization = `Bearer ${options.token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (cause) {
    throw new TransportError(url, cause);
  }

  const text = await response.text();
  let parsed: unknown = undefined;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const body =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    throw new ApiError(
      response.status,
      typeof body.error === "string" ? body.error : undefined,
      typeof body.message === "string"
        ? body.message
        : `HTTP ${response.status}`,
      parsed,
    );
  }
  return parsed;
};
