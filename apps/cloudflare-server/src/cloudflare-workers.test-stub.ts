/** Minimal Vitest-only base class; Worker methods under test do not use runtime bindings. */
export class DurableObject {
  constructor(..._args: unknown[]) {}
}
