import { Schema } from "effect";

export * from "./graph";

export const Health = Schema.Struct({
  service: Schema.Literal("yakjev"),
  status: Schema.Literal("ok"),
  stage: Schema.Literal("scaffold"),
  storage: Schema.Literal("sqlite"),
});

export type Health = typeof Health.Type;
