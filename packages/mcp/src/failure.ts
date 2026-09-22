import { Schema } from "effect";
import { AuthError } from "@yakjev/server/auth";
import { DomainError } from "@yakjev/server/domain";
import { DiscoveryError } from "@yakjev/server/discovery";
import { StorageError } from "@yakjev/server/store";

export class ToolFailure extends Schema.TaggedError<ToolFailure>()(
  "ToolFailure",
  {
    error: Schema.Literals([
      "Invalid",
      "NotFound",
      "Conflict",
      "StorageError",
      "Unavailable",
    ]),
    message: Schema.String,
    currentRevision: Schema.optionalKey(Schema.Int),
  },
) {}

export const invalid = (message: string) =>
  new ToolFailure({ error: "Invalid", message });

export const mapFailure = (
  error: DomainError | StorageError | DiscoveryError | AuthError,
): ToolFailure => {
  if (error instanceof DomainError) {
    return new ToolFailure({
      error: error.code,
      message: error.message,
      ...(error.currentRevision === undefined
        ? {}
        : { currentRevision: error.currentRevision }),
    });
  }
  if (error instanceof AuthError) {
    return new ToolFailure({ error: "Invalid", message: error.message });
  }
  if (error instanceof DiscoveryError) {
    return new ToolFailure({ error: "Invalid", message: error.message });
  }
  return new ToolFailure({
    error: "StorageError",
    message: "Graph storage is unavailable.",
  });
};
