import { NodeFileSystem } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Run an Effect program in tests with Node file system I/O. */
export const runEffect = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  ...extra: Array<Layer.Layer<R, never, never>>
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(program, Layer.mergeAll(NodeFileSystem.layer, ...extra)),
  );
