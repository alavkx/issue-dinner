# Agent guide

## Vendored repositories

This project vendors external repositories under `repos/`:

- **`repos/effect`** — [Effect-TS/effect](https://github.com/Effect-TS/effect) (read-only reference)

Rules:

- Use vendored repositories as **read-only reference material** when working with related libraries.
- Prefer examples and patterns from the vendored source code over generated guesses or web search.
- **Do not edit files under `repos/`** unless explicitly asked.
- **Do not import from `repos/`** — application code imports from normal package dependencies (`effect`, `@effect/platform`, etc.).

When writing Effect code, inspect `repos/effect/` for idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect patterns.

## Source vs config vs state

This repository is **source code** for the CLI. When users run issue-dinner on their projects, runtime data does **not** belong here.

| Kind | Location | In git? |
| ---- | -------- | ------- |
| **Source** | `src/`, tests, docs | Yes |
| **Install config** | `~/.config/issue-dinner/config.json` (or `issue-dinner.config.json` in cwd) | No — gitignored |
| **Runtime state** | `~/.local/state/issue-dinner/` by default (`ISSUE_DINNER_STATE_DIR` to override) | No |

**Normal runs:** agents work in configured **project workspaces** (backend, frontend, etc.). State (runs, logs, transcripts, durable heals) writes under the user state dir only.

**Self-heal / dogfooding:** when issue-dinner fixes itself, `resolveProjectRoot()` targets this package. Agents edit `src/` here; durable heals persist under state; `.issue-dinner/heals/applied/` may appear under the package root (gitignored). Setting `ISSUE_DINNER_STATE_DIR=.state` during development is why `.state/` can exist locally — it must stay gitignored.

Do not embed machine paths, API keys, run logs, or heal snapshots in tracked files. See `docs/runtime-layout.md`.

## Application architecture

- **Effect at the core**: business logic is `Effect` programs; dependencies are `Context.Tag` services exposed via `Layer`.
- **CLI boundary**: `cli.ts` is the only place that calls `Effect.runPromise` / `NodeRuntime.runMain`.
- **Errors**: domain failures use `Schema.TaggedError` (or `Data.TaggedError`) — not bare `throw` or string errors.
- **I/O**: file system and subprocess work go through `@effect/platform` (`FileSystem`, `Command`) with `NodeFileSystem` / `NodeContext` at the edge.
- **Tests**: behavior through public service interfaces; provide test layers or `NodeFileSystem.layer` in test helpers under `src/effect/test-runtime.ts`.
