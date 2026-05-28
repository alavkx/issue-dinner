import * as Schema from "effect/Schema";

/** Install config file missing or unreadable. */
export class ConfigNotFound extends Schema.TaggedError<ConfigNotFound>()(
  "ConfigNotFound",
  {
    message: Schema.String,
  },
) {}

/** Cursor API key env var missing. */
export class MissingCursorApiKey extends Schema.TaggedError<MissingCursorApiKey>()(
  "MissingCursorApiKey",
  {
    envVar: Schema.String,
    message: Schema.String,
  },
) {}

/** Subprocess exited with a non-zero code. */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()(
  "CommandFailed",
  {
    command: Schema.String,
    args: Schema.Array(Schema.String),
    code: Schema.Number,
    stdout: Schema.String,
    stderr: Schema.String,
    message: Schema.String,
  },
) {}
