import { PlatformLive } from "./layers.js";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Run an Effect program in tests with Node platform services. */
export const runEffect = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  ...extra: Array<Layer.Layer<R, never, never>>
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(program, Layer.mergeAll(PlatformLive, ...extra)),
  );
