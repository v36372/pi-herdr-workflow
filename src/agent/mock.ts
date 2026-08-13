import type { AgentStartContext } from "../herdr/pi-args.js";
import { writeFakeAgentResult } from "../herdr/result-file.js";
import type { MaybePromise } from "../workflows/types.js";
import type {
  AgentFinishRequest,
  AgentMedium,
  AgentPromptOutcome,
  AgentPromptRequest,
  AgentSession,
} from "./medium.js";
import { AgentProtocolExecutor, type AgentProtocolExecutorOptions } from "./protocol.js";

export type MockAgentTurn = {
  ctx: AgentStartContext;
  session: AgentSession;
  prompt: string;
  submission: number;
  signal: AbortSignal;
};

/**
 * Return the structured output to write as `result.json`.
 * Return `undefined` / `false` to settle without `workflow_done` (retry path).
 * Return `true` if the handler already wrote `result.json`.
 */
export type MockAgentHandler = (turn: MockAgentTurn) => MaybePromise<unknown | void | boolean>;

/**
 * In-process agent medium for tests. Records start/prompt and writes
 * `result.json` the same way a child `workflow_done` would.
 */
export class MockAgentMedium implements AgentMedium {
  readonly delivery = "live" as const;
  readonly starts: AgentStartContext[] = [];
  readonly prompts: Array<{ prompt: string; submission: number }> = [];
  private ctx: AgentStartContext | undefined;
  private readonly handler: MockAgentHandler;

  constructor(handler: MockAgentHandler = () => ({ ok: true })) {
    this.handler = handler;
  }

  async start(ctx: AgentStartContext, _signal: AbortSignal): Promise<AgentSession> {
    this.ctx = ctx;
    this.starts.push(ctx);
    return {
      agentName: ctx.spawn.name,
      paneId: "mock",
      startMessage: `mock start ${ctx.spawn.name}`,
    };
  }

  async prompt(session: AgentSession, request: AgentPromptRequest): Promise<AgentPromptOutcome> {
    const ctx = this.ctx;
    if (!ctx) {
      throw new Error("MockAgentMedium.prompt called before start");
    }
    this.prompts.push({ prompt: request.prompt, submission: request.submission });
    if (request.signal.aborted) {
      return { killedByAbort: true };
    }
    const output = await this.handler({
      ctx,
      session,
      prompt: request.prompt,
      submission: request.submission,
      signal: request.signal,
    });
    if (request.signal.aborted) {
      return { killedByAbort: true };
    }
    if (output === undefined || output === false) {
      return {};
    }
    if (output !== true) {
      writeFakeAgentResult({
        resultPath: ctx.resultPath,
        runId: ctx.contract.runId,
        nodeId: ctx.contract.nodeId,
        attemptId: ctx.contract.attemptId,
        output,
      });
    }
    return {};
  }

  async finish(_session: AgentSession, _request: AgentFinishRequest): Promise<void> {
    // No pane to close.
  }
}

/** {@link AgentProtocolExecutor} over {@link MockAgentMedium}. */
export class MockAgentExecutor extends AgentProtocolExecutor {
  readonly mock: MockAgentMedium;

  constructor(
    handler?: MockAgentHandler,
    options: Omit<AgentProtocolExecutorOptions, "medium"> = {},
  ) {
    const mock = new MockAgentMedium(handler);
    super({ ...options, medium: mock });
    this.mock = mock;
  }
}
