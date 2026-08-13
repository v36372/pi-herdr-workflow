import { Effect } from "effect";
import type { AgentWaitProgress } from "../agent/medium.js";
import {
  AgentProtocolExecutor,
  DEFAULT_MAX_VALIDATION_ATTEMPTS,
} from "../agent/protocol.js";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
} from "../workflows/types.js";
import { HerdrMedium, type HerdrMediumOptions } from "./medium.js";

export type { AgentStartContext } from "./pi-args.js";
export {
  buildKindBootstrapLines,
  defaultAgentArgs,
  isInsideHerdr,
  resolveHerdrKind,
} from "./pi-args.js";
export { writeFakeAgentResult } from "./result-file.js";
export { DEFAULT_MAX_VALIDATION_ATTEMPTS };
export type { HerdrOriginFocus } from "./medium.js";
export { HerdrMedium } from "./medium.js";

export type HerdrAgentWaitProgress = AgentWaitProgress;

export type HerdrStepExecutorOptions = HerdrMediumOptions & {
  /** Override the child `workflow_done` extension path. */
  childExtensionPath?: string;
  /**
   * Max prompt/settle cycles for one agent step, including the first attempt.
   * Covers both missing `workflow_done` and validator rejections. Default 3.
   */
  maxValidationAttempts?: number;
};

/**
 * Agent-step executor that uses Herdr panes as the orchestration medium.
 *
 * Layout and `herdr agent start/prompt --wait` live on {@link HerdrMedium}.
 * Skills, `task.md`, `result.json`, and validation retries live on
 * {@link AgentProtocolExecutor}.
 */
export class HerdrStepExecutor implements AgentStepExecutor {
  private readonly medium: HerdrMedium;
  private readonly protocol: AgentProtocolExecutor;

  constructor(options: HerdrStepExecutorOptions = {}) {
    this.medium = new HerdrMedium(options);
    this.protocol = new AgentProtocolExecutor({
      medium: this.medium,
      cwd: options.cwd,
      childExtensionPath: options.childExtensionPath,
      maxValidationAttempts: options.maxValidationAttempts,
      onProgress: options.onProgress,
    });
  }

  get runWorkspaceId(): string | null {
    return this.medium.runWorkspaceId;
  }

  get runTabIdValue(): string | null {
    return this.medium.runTabIdValue;
  }

  async dispose(signal?: AbortSignal): Promise<void> {
    await this.protocol.dispose(signal);
  }

  /** Effect form of {@link runAgentStep}. */
  runAgentStepEffect(
    request: AgentStepRequest,
    signal: AbortSignal,
  ): Effect.Effect<AgentStepSubmission, Error> {
    return Effect.tryPromise({
      try: () => this.runAgentStep(request, signal),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
  }

  async runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission> {
    return await this.protocol.runAgentStep(request, signal);
  }
}
