import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { Actor, Id } from "@yakjev/protocol";
import { Context, Data, DateTime, Effect, Layer, Schema } from "effect";

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly code: "Unauthorized" | "Forbidden";
  readonly message: string;
}> {}

export interface AuthOptions {
  readonly origin: string;
  readonly ownerToken: string;
  readonly ownerId?: string;
}
type RequestHeaders = Readonly<Record<string, string | undefined>>;
const lifetimeSeconds = 24 * 60 * 60;
const digest = (value: string) => createHash("sha256").update(value).digest();
const equals = (left: string, right: string) =>
  timingSafeEqual(digest(left), digest(right));

export class Auth extends Context.Service<
  Auth,
  {
    readonly bearer: (
      headers: RequestHeaders,
    ) => Effect.Effect<Actor, AuthError>;
    readonly browser: (
      headers: RequestHeaders,
      mutation: boolean,
    ) => Effect.Effect<Actor, AuthError>;
    readonly login: (
      headers: RequestHeaders,
      token: string,
    ) => Effect.Effect<string, AuthError>;
    readonly logout: (
      headers: RequestHeaders,
    ) => Effect.Effect<string, AuthError>;
  }
>()("@yakjev/Auth") {
  static layer(options: AuthOptions) {
    return Layer.effect(
      Auth,
      Effect.gen(function* () {
        const origin = yield* Effect.try(() => new URL(options.origin));
        const cookieName =
          origin.protocol === "https:"
            ? "__Host-yakjev_session"
            : "yakjev_session";
        const id = yield* Schema.decodeUnknownEffect(Id)(
          options.ownerId ?? "owner",
        );
        if (options.ownerToken.length < 32)
          return yield* Effect.fail(
            new Error("YAKJEV_OWNER_TOKEN must contain at least 32 characters"),
          );
        const key = digest(options.ownerToken);
        const sign = (payload: string) =>
          createHmac("sha256", key)
            .update(`yakjev-session:${payload}`)
            .digest("base64url");
        const cookie = (value: string, maxAge: number) =>
          `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.protocol === "https:" ? "; Secure" : ""}`;
        const checkOrigin = Effect.fnUntraced(function* (
          headers: RequestHeaders,
          required: boolean,
        ) {
          if (
            (required && headers.origin !== origin.origin) ||
            (headers.origin && headers.origin !== origin.origin)
          )
            return yield* new AuthError({
              code: "Forbidden",
              message: "Forbidden origin",
            });
        });
        const bearer = Effect.fn("Auth.bearer")(function* (
          headers: RequestHeaders,
        ) {
          yield* checkOrigin(headers, false);
          const authorization = headers.authorization;
          if (
            !authorization?.startsWith("Bearer ") ||
            !equals(authorization.slice(7), options.ownerToken)
          )
            return yield* new AuthError({
              code: "Unauthorized",
              message: "Owner authentication required",
            });
          return { id, channel: "mcp" } satisfies Actor;
        });
        const browser = Effect.fn("Auth.browser")(function* (
          headers: RequestHeaders,
          mutation: boolean,
        ) {
          if (headers.authorization) {
            yield* bearer(headers);
            return { id, channel: "browser" } satisfies Actor;
          }
          yield* checkOrigin(headers, mutation);
          const value = headers.cookie
            ?.split(";")
            .map((part) => part.trim())
            .find((part) => part.startsWith(`${cookieName}=`))
            ?.slice(cookieName.length + 1);
          const match = value?.match(
            /^(\d+)\.([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/,
          );
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          if (
            !match ||
            Number(match[1]) <= now ||
            !equals(match[3]!, sign(`${match[1]}.${match[2]}`))
          )
            return yield* new AuthError({
              code: "Unauthorized",
              message: "Owner authentication required",
            });
          return { id, channel: "browser" } satisfies Actor;
        });
        const login = Effect.fn("Auth.login")(function* (
          headers: RequestHeaders,
          token: string,
        ) {
          yield* checkOrigin(headers, true);
          if (!equals(token, options.ownerToken))
            return yield* new AuthError({
              code: "Unauthorized",
              message: "Invalid owner credential",
            });
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const nonce = yield* Effect.sync(() =>
            randomBytes(24).toString("base64url"),
          );
          const payload = `${now + lifetimeSeconds * 1000}.${nonce}`;
          return cookie(`${payload}.${sign(payload)}`, lifetimeSeconds);
        });
        const logout = Effect.fn("Auth.logout")(function* (
          headers: RequestHeaders,
        ) {
          yield* checkOrigin(headers, true);
          return cookie("", 0);
        });
        return { bearer, browser, login, logout };
      }),
    );
  }
}
