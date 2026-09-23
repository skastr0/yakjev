import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Context, Effect, Layer } from "effect";
import { decodeOrigin, DesktopError } from "./config";

// Only a server origin is persisted here. Chromium owns the HttpOnly session;
// main forwards login bytes without parsing or retaining the owner's token.
export class Settings extends Context.Service<
  Settings,
  {
    readonly read: Effect.Effect<string | undefined, DesktopError>;
    readonly save: (origin: string) => Effect.Effect<void, DesktopError>;
  }
>()("@yakjev/desktop/Settings") {
  static layer(path: string) {
    return Layer.succeed(Settings, {
      read: Effect.gen(function* () {
        const raw = yield* Effect.tryPromise({
          try: async () => {
            try {
              return await readFile(path, "utf8");
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code === "ENOENT")
                return undefined;
              throw cause;
            }
          },
          catch: () =>
            new DesktopError({
              message: "Could not read the desktop connection settings.",
            }),
        });
        if (raw === undefined) return undefined;
        const parsed = yield* Effect.try({
          try: (): unknown => JSON.parse(raw),
          catch: () =>
            new DesktopError({
              message:
                "The desktop connection settings are invalid. Choose your server again.",
            }),
        });
        return yield* decodeOrigin(
          typeof parsed === "object" && parsed !== null && "origin" in parsed
            ? parsed.origin
            : undefined,
        );
      }),
      save: (origin) =>
        Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            const temporary = `${path}.tmp`;
            await writeFile(temporary, JSON.stringify({ origin }) + "\n", {
              mode: 0o600,
            });
            await rename(temporary, path);
          },
          catch: () =>
            new DesktopError({
              message: "Could not save the desktop connection settings.",
            }),
        }),
    });
  }
}
