import { writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
} from "../workflows/types.js";
import { preloadSkills, resolveAgentLaunch } from "../herdr/agent-defaults.js";
import {
  buildMissingResultRetryPrompt,
  buildValidationRetryPrompt,
  resolveChildExtensionPath,
  writeAgentEnvScript,
} from "../herdr/pi-args.js";
import {
  clearResultFile,
  ensureArtifactDir,
  readResultFile,
  writeTaskFile,
} from "../herdr/result-file.js";
import type { AgentMedium, AgentSession, AgentWaitProgress } from "./medium.js";

/** Explicit ceiling for prompt/settle cycles (initial + retries). */
export const DEFAULT_MAX_VALIDATION_ATTEMPTS = 3;

export type AgentProtocolExecutorOptions = {
  medium: AgentMedium;
  cwd?: string;
  /** Override the child `workflow_done` extension path. */
  childExtensionPath?: string;
  /**
   * Max prompt/settle cycles for one agent step, including the first attempt.
   * Covers both missing `workflow_done` and validator rejections. Default 3.
   */
  maxValidationAttempts?: number;
  onProgress?: (event: AgentWaitProgress) => void;
};

/**
 * Shared agent-step protocol: resolve launch, preload skills, write `task.md`
 * / `agent-env.sh`, then loop prompt → `result.json` → accept/retry on a medium.
 */
export class AgentProtocolExecutor implements AgentStepExecutor {
  private readonly medium: AgentMedium;
  private readonly cwd?: string;
  private readonly childExtensionPath: string;
  private readonly maxValidationAttempts: number;
  private readonly onProgress?: (event: AgentWaitProgress) => void;

  constructor(options: AgentProtocolExecutorOptions) {
    this.medium = options.medium;
    this.cwd = options.cwd;
    this.childExtensionPath = options.childExtensionPath ?? resolveChildExtensionPath();
    this.maxValidationAttempts = Math.max(
      1,
      options.maxValidationAttempts ?? DEFAULT_MAX_VALIDATION_ATTEMPTS,
    );
    this.onProgress = options.onProgress;
  }

  async dispose(signal?: AbortSignal): Promise<void> {
    await this.medium.dispose?.(signal);
  }

  async runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission> {
    const { contract } = request;
    ensureArtifactDir(contract.artifactDir);
    clearResultFile(contract.resultPath);
    const launch = resolveAgentLaunch(request.spawn, this.cwd);
    const spawn = this.medium.adaptSpawn?.(launch.spawn) ?? launch.spawn;
    const rolePrompt = launch.rolePrompt
      ? `${launch.rolePrompt}\n\n${request.prompt}`
      : request.prompt;
    const prompt = await preloadSkills(
      rolePrompt,
      spawn.skills,
      spawn.cwd ?? this.cwd ?? process.cwd(),
    );
    const taskPath = writeTaskFile(contract.artifactDir, prompt);
    const startContext = {
      spawn,
      prompt,
      contract,
      taskPath,
      resultPath: contract.resultPath,
      artifactDir: contract.artifactDir,
      childExtensionPath: this.childExtensionPath,
      ...(launch.thinking ? { thinking: launch.thinking } : {}),
      ...(launch.replaceSystemPrompt ? { replaceSystemPrompt: launch.replaceSystemPrompt } : {}),
      appendSystemPrompts: launch.appendSystemPrompts,
    };
    writeAgentEnvScript(startContext);

    throwIfAborted(signal);

    let session: AgentSession | undefined;
    const interrupt = (): void => {
      if (!session) return;
      this.medium.interrupt?.(session);
    };
    signal.addEventListener("abort", interrupt, { once: true });
    if (signal.aborted) interrupt();

    try {
      session = await this.medium.start(startContext, signal);
      throwIfAborted(signal);
      this.emit(session, spawn.name, contract.nodeId, {
        phase: "agent_start",
        message: session.startMessage ?? `start ${session.agentName}`,
      });

      let nextPrompt = prompt;
      let nextPromptFile = taskPath;
      let lastFailure: { kind: "missing_result" | "validation"; message: string } | null = null;
      const retryVerb = this.medium.delivery === "live" ? "re-prompt" : "respawn";

      for (let submission = 1; submission <= this.maxValidationAttempts; submission++) {
        const retryPhase =
          lastFailure?.kind === "missing_result"
            ? "completion_retry"
            : lastFailure?.kind === "validation"
              ? "validation_retry"
              : "agent_prompt";
        this.emit(session, spawn.name, contract.nodeId, {
          phase: submission === 1 ? "agent_prompt" : retryPhase,
          message:
            submission === 1
              ? this.medium.delivery === "live"
                ? `prompt ${session.agentName}`
                : `pi -p ${session.agentName}`
              : lastFailure?.kind === "missing_result"
                ? `missing workflow_done; ${retryVerb} ${session.agentName} (${submission}/${this.maxValidationAttempts})`
                : `validation rejected; ${retryVerb} ${session.agentName} (${submission}/${this.maxValidationAttempts})`,
          submission,
        });

        if (submission > 1) {
          nextPromptFile = path.join(contract.artifactDir, `retry-${submission}.md`);
          writeFileSync(nextPromptFile, nextPrompt, "utf8");
        }

        clearResultFile(contract.resultPath);
        const outcome = await this.medium.prompt(session, {
          prompt: nextPrompt,
          promptFile: nextPromptFile,
          submission,
          signal,
        });
        if (outcome.killedByAbort || signal.aborted) {
          throwIfAborted(signal);
          throw new Error("Aborted");
        }

        const hasResult = Boolean(readResultFile(contract.resultPath));
        if (!hasResult) {
          lastFailure = {
            kind: "missing_result",
            message: `Agent ${spawn.name} settled without calling workflow_done (${contract.resultPath})${outcome.detail ?? ""}`,
          };
          if (submission >= this.maxValidationAttempts) break;
          nextPrompt = buildMissingResultRetryPrompt(submission, this.maxValidationAttempts);
          continue;
        }

        const accepted = await acceptSubmission(request);
        if (accepted.ok) {
          this.emit(session, spawn.name, contract.nodeId, {
            phase: "result",
            message: `workflow_done accepted for ${contract.nodeId}`,
            submission,
          });
          await this.medium.finish?.(session, { spawn, signal });
          return { output: accepted.value };
        }

        lastFailure = { kind: "validation", message: accepted.error };
        clearResultFile(contract.resultPath);
        if (submission >= this.maxValidationAttempts) break;
        nextPrompt = buildValidationRetryPrompt(
          accepted.error,
          submission,
          this.maxValidationAttempts,
        );
      }

      if (lastFailure?.kind === "missing_result") {
        throw new Error(`${lastFailure.message} after ${this.maxValidationAttempts} submission(s)`);
      }
      throw new Error(
        `Agent output rejected after ${this.maxValidationAttempts} submission(s): ${lastFailure?.message ?? "unknown validation error"}`,
      );
    } finally {
      signal.removeEventListener("abort", interrupt);
      if (session) {
        await this.medium.afterStep?.(session, signal);
      }
    }
  }

  private emit(
    session: AgentSession,
    spawnName: string,
    nodeId: string,
    event: { phase: AgentWaitProgress["phase"]; message: string; submission?: number },
  ): void {
    this.onProgress?.({
      phase: event.phase,
      paneId: session.paneId,
      agentName: session.agentName,
      nodeId,
      spawnName,
      message: event.message,
      ...(event.submission !== undefined
        ? { submission: event.submission, maxSubmissions: this.maxValidationAttempts }
        : {}),
    });
  }
}

async function acceptSubmission(
  request: AgentStepRequest,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const result = readResultFile(request.contract.resultPath);
  if (!result) {
    return {
      ok: false,
      error: `Agent went idle without writing result file at ${request.contract.resultPath}`,
    };
  }
  return await request.accept(result.output);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
}
