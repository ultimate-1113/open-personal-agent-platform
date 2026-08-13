/* eslint-disable @typescript-eslint/no-unsafe-assignment */
export class WorkerEntrypoint<Env = unknown> {
  readonly env: Env;
  readonly ctx: ExecutionContext;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class DurableObject<Env = unknown> {
  readonly ctx: DurableObjectState;
  readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
