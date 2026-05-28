import * as Effect from "effect/Effect";
import { MissingCursorApiKey } from "./effect/errors.js";

const API_KEY_ENV = "ISSUE_DINNER_CURSOR_API_KEY";

export const cursorApiKey: Effect.Effect<string, MissingCursorApiKey> =
  Effect.gen(function* () {
    const key = process.env[API_KEY_ENV];
    if (!key?.trim()) {
      return yield* Effect.fail(
        new MissingCursorApiKey({
          envVar: API_KEY_ENV,
          message: `${API_KEY_ENV} is not set. Export a key from https://cursor.com/dashboard/integrations`,
        }),
      );
    }
    return key.trim();
  });

export function cursorApiKeyEnvName(): string {
  return API_KEY_ENV;
}
