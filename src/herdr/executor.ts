import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
  ResolvedAgentSpawn,
} from "../workflows/types.js";
import { preloadSkills, resolveAgentLaunch } from "./agent-defaults.js";
import { HerdrClient, HerdrError, isHerdrError } from "./client.js";
import {
  clearResultFile,
  ensureArtifactDir,
  readResultFile,
  sleep,
  writeTaskFile,
} from "./result-file.js";

/** Explicit ceiling for same-pane validation resubmissions (initial + retries). */
export const DEFAULT_MAX_VALIDATION_ATTEMPTS = 3;

export type HerdrAgentWaitProgress = {
  phase: "agent_start" | "agent_prompt" | "blocked" | "validation_retry" | "result";
  paneId: string;
  agentName: string;
  nodeId: string;
  spawnName: string;
  message: string;
  submission?: number;
  maxSubmissions?: number;
};

export type HerdrStepExecutorOptions = {
  client?: HerdrClient;
  /**
   * Existing workspace to host agent panes. When omitted, the first agent
   * step creates one labeled with the run id and reuses it for the run.
   */
  workspaceId?: string;
  /** cwd for newly created workspaces / panes. */
  cwd?: string;
  /** Build native arguments passed after `herdr agent start ... --`. */
  buildAgentArgs?: (ctx: AgentStartContext) => string[];
  /** Close the run workspace when the executor is disposed. Default false. */
  closeWorkspaceOnDispose?: boolean;
  /** Max time for `agent prompt --wait`. Default 30m. Engine abort still wins. */
  completionTimeoutMs?: number;
  /**
   * Max accepted `workflow_done` submissions for one agent step, including the
   * first attempt. Validation failures re-prompt in the same live agent until
   * this ceiling. Default 3.
   */
  maxValidationAttempts?: number;
  /** Progress hook for orchestrator tool updates. */
  onProgress?: (event: HerdrAgentWaitProgress) => void;
};

export type AgentStartContext = {
  spawn: ResolvedAgentSpawn;
  prompt: string;
  contract: AgentStepRequest["contract"];
  taskPath: string;
  resultPath: string;
  artifactDir: string;
  /** Absolute path to this package's child extension entry. */
  childExtensionPath: string;
  thinking?: string;
  replaceSystemPrompt?: string;
  appendSystemPrompts: string[];
};

/**
 * Runs agent steps in Herdr panes.
 *
 * Layout:
 * - one workspace per workflow run (created on first agent step, or injected)
 * - one pane per agent attempt, labeled with spawn.name
 * - environment prepared in the pane shell before Herdr starts interactive pi
 * Completion path:
 * 1. workspace/pane allocation
 * 2. `herdr agent start ... --kind pi` validates interactive readiness
 * 3. `herdr agent prompt ... --wait` blocks on a lifecycle signal
 * 4. read authoritative result.json written by workflow_done
 * 5. on validation rejection, clear result.json and re-prompt the same agent
 */
export class HerdrStepExecutor implements AgentStepExecutor {
  private readonly client: HerdrClient;
  private readonly cwd?: string;
  private readonly buildAgentArgs: (ctx: AgentStartContext) => string[];
  private readonly closeWorkspaceOnDispose: boolean;
  private readonly completionTimeoutMs: number;
  private readonly maxValidationAttempts: number;
  private readonly onProgress?: (event: HerdrAgentWaitProgress) => void;
  private readonly childExtensionPath: string;
  private workspaceId: string | null;
  private ownsWorkspace = false;
  private rootPaneId: string | null = null;
  private lastPaneId: string | null = null;

  constructor(options: HerdrStepExecutorOptions = {}) {
    this.client = options.client ?? new HerdrClient();
    this.cwd = options.cwd;
    this.workspaceId = options.workspaceId ?? null;
    this.buildAgentArgs = options.buildAgentArgs ?? defaultAgentArgs;
    this.closeWorkspaceOnDispose = options.closeWorkspaceOnDispose ?? false;
    this.completionTimeoutMs = options.completionTimeoutMs ?? 30 * 60_000;
    this.maxValidationAttempts = Math.max(1, options.maxValidationAttempts ?? DEFAULT_MAX_VALIDATION_ATTEMPTS);
    this.onProgress = options.onProgress;
    this.childExtensionPath = resolveChildExtensionPath();
  }

  get runWorkspaceId(): string | null {
    return this.workspaceId;
  }

  async dispose(signal?: AbortSignal): Promise<void> {
    if (this.closeWorkspaceOnDispose && this.ownsWorkspace && this.workspaceId) {
      try {
        await this.client.workspaceClose(this.workspaceId, signal);
      } catch {
        // Best effort.
      }
    }
  }

  async runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission> {
    const { contract } = request;
    ensureArtifactDir(contract.artifactDir);
    clearResultFile(contract.resultPath);
    const launch = resolveAgentLaunch(request.spawn, this.cwd);
    const { spawn } = launch;
    const rolePrompt = launch.rolePrompt
      ? `${launch.rolePrompt}\n\n${request.prompt}`
      : request.prompt;
    const prompt = await preloadSkills(
      rolePrompt,
      spawn.skills,
      spawn.cwd ?? this.cwd ?? process.cwd(),
    );
    const taskPath = writeTaskFile(contract.artifactDir, prompt);

    await this.ensureWorkspace(spawn, contract.runId, signal);
    const paneId = await this.allocatePane(spawn, signal);
    const startContext: AgentStartContext = {
      spawn,
      prompt,
      contract,
      taskPath,
      resultPath: contract.resultPath,
      artifactDir: contract.artifactDir,
      childExtensionPath: this.childExtensionPath,
      ...(launch.thinking ? { thinking: launch.thinking } : {}),
      ...(launch.replaceSystemPrompt
        ? { replaceSystemPrompt: launch.replaceSystemPrompt }
        : {}),
      appendSystemPrompts: launch.appendSystemPrompts,
    };
    const agentName = liveAgentName(spawn.name, contract.attemptId);

    try {
      await this.prepareAgentEnvironment(paneId, startContext, signal);
      this.onProgress?.({
        phase: "agent_start",
        paneId,
        agentName,
        nodeId: contract.nodeId,
        spawnName: spawn.name,
        message: `herdr agent start ${agentName} --kind pi --pane ${paneId}`,
      });
      try {
        await this.client.agentStart(
          {
            name: agentName,
            kind: "pi",
            paneId,
            args: this.buildAgentArgs(startContext),
          },
          signal,
        );
      } catch (error) {
        throw this.mapAgentControlError(error, agentName, "start");
      }

      let nextPrompt = prompt;
      let lastValidationError: string | null = null;
      for (let submission = 1; submission <= this.maxValidationAttempts; submission++) {
        this.onProgress?.({
          phase: submission === 1 ? "agent_prompt" : "validation_retry",
          paneId,
          agentName,
          nodeId: contract.nodeId,
          spawnName: spawn.name,
          message:
            submission === 1
              ? `herdr agent prompt ${agentName} --wait`
              : `validation rejected; re-prompt ${agentName} (${submission}/${this.maxValidationAttempts})`,
          submission,
          maxSubmissions: this.maxValidationAttempts,
        });

        // Drop any previous payload before waiting so a rejected result cannot
        // be accepted again if the agent settles without rewriting the file.
        clearResultFile(contract.resultPath);
        try {
          await this.client.agentPrompt(
            agentName,
            nextPrompt,
            { wait: true, timeoutMs: this.completionTimeoutMs },
            signal,
          );
        } catch (error) {
          throw this.mapAgentControlError(error, agentName, "prompt");
        }
        await this.waitForWorkflowDone(
          agentName,
          paneId,
          contract.resultPath,
          { nodeId: contract.nodeId, spawnName: spawn.name },
          signal,
        );

        const accepted = await this.acceptSubmission(request);
        if (accepted.ok) {
          this.onProgress?.({
            phase: "result",
            paneId,
            agentName,
            nodeId: contract.nodeId,
            spawnName: spawn.name,
            message: `workflow_done accepted for ${contract.nodeId}`,
            submission,
            maxSubmissions: this.maxValidationAttempts,
          });
          return { output: accepted.value };
        }

        lastValidationError = accepted.error;
        clearResultFile(contract.resultPath);
        if (submission >= this.maxValidationAttempts) break;
        // Keep task.md as the original submitted task; retries only re-prompt live.
        nextPrompt = buildValidationRetryPrompt(accepted.error, submission, this.maxValidationAttempts);
      }

      throw new Error(
        `Agent output rejected after ${this.maxValidationAttempts} submission(s): ${lastValidationError}`,
      );
    } finally {
      this.lastPaneId = paneId;
    }
  }

  /** `agent prompt --wait` is the lifecycle signal; result.json is authoritative. */
  private async waitForWorkflowDone(
    agentName: string,
    paneId: string,
    resultPath: string,
    meta: { nodeId: string; spawnName: string },
    signal: AbortSignal,
  ): Promise<void> {
    if (readResultFile(resultPath)) return;

    let agent;
    try {
      agent = await this.client.agentGet(agentName, signal);
    } catch (error) {
      throw this.mapAgentControlError(error, agentName, "get");
    }

    if (agent.agent_status === "blocked") {
      this.onProgress?.({
        phase: "blocked",
        paneId,
        agentName,
        nodeId: meta.nodeId,
        spawnName: meta.spawnName,
        message: `${agentName} is blocked; waiting for user input`,
      });
      try {
        await this.client.agentWait(
          agentName,
          ["idle", "done"],
          this.completionTimeoutMs,
          signal,
        );
      } catch (error) {
        throw this.mapAgentControlError(error, agentName, "wait");
      }
      if (readResultFile(resultPath)) return;
    }

    throw new Error(
      `Agent ${meta.spawnName} settled without calling workflow_done (${resultPath})`,
    );
  }

  private async acceptSubmission(
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

  private mapAgentControlError(
    error: unknown,
    agentName: string,
    operation: "start" | "prompt" | "get" | "wait",
  ): Error {
    if (!isHerdrError(error)) {
      return error instanceof Error ? error : new Error(String(error));
    }
    switch (error.code) {
      case "protocol_mismatch":
        return new HerdrError(
          error.code,
          `Herdr protocol mismatch while ${operation}ing agent ${agentName}. Upgrade Herdr/pi-herdr-workflows so CLI and server agree. ${error.message}`,
          { args: error.args, exitCode: error.exitCode, id: error.id, cause: error },
        );
      case "agent_prompt_stalled":
        return new HerdrError(
          error.code,
          `Agent ${agentName} did not begin working after prompt submission (agent_prompt_stalled). The pane may be blocked on a prompt, offline, or not accepting input. ${error.message}`,
          { args: error.args, exitCode: error.exitCode, id: error.id, cause: error },
        );
      case "agent_not_running":
        return new HerdrError(
          error.code,
          `Agent ${agentName} is no longer running in its pane (agent_not_running) during ${operation}. ${error.message}`,
          { args: error.args, exitCode: error.exitCode, id: error.id, cause: error },
        );
      default:
        return error;
    }
  }

  private async ensureWorkspace(
    spawn: ResolvedAgentSpawn,
    runId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.workspaceId) {
      if (!this.rootPaneId) {
        const panes = await this.client.paneList(this.workspaceId, signal);
        this.rootPaneId = panes[0]?.pane_id ?? null;
        this.lastPaneId = this.rootPaneId;
      }
      return;
    }
    const created = await this.client.workspaceCreate(
      {
        cwd: spawn.cwd ?? this.cwd,
        label: `wf:${runId}`.slice(0, 48),
        focus: false,
      },
      signal,
    );
    this.workspaceId = created.workspace_id;
    this.ownsWorkspace = true;
    this.rootPaneId = created.pane_id ?? null;
    if (!this.rootPaneId) {
      const panes = await this.client.paneList(this.workspaceId, signal);
      this.rootPaneId = panes[0]?.pane_id ?? null;
    }
    this.lastPaneId = this.rootPaneId;
  }

  private async allocatePane(spawn: ResolvedAgentSpawn, signal: AbortSignal): Promise<string> {
    if (!this.workspaceId) {
      throw new Error("Herdr workspace not initialized");
    }
    const sourcePane = this.lastPaneId ?? this.rootPaneId;
    if (!sourcePane) {
      throw new Error(`No pane available in workspace ${this.workspaceId}`);
    }

    // First agent can reuse the workspace root pane if it is still empty of
    // work; subsequent agents split from the last pane.
    let paneId: string;
    if (this.lastPaneId === this.rootPaneId && this.ownsWorkspace && !this.hasUsedRoot) {
      paneId = sourcePane;
      this.hasUsedRoot = true;
    } else {
      const split = await this.client.paneSplit(
        {
          paneId: sourcePane,
          direction: "right",
          cwd: spawn.cwd ?? this.cwd,
          focus: false,
        },
        signal,
      );
      paneId = split.pane_id;
    }

    try {
      await this.client.paneRename(paneId, spawn.name, signal);
    } catch {
      // Label is cosmetic.
    }
    this.lastPaneId = paneId;
    return paneId;
  }

  private hasUsedRoot = false;

  private async prepareAgentEnvironment(
    paneId: string,
    ctx: AgentStartContext,
    signal: AbortSignal,
  ): Promise<void> {
    await this.waitForShellReady(paneId, signal);
    const setupPath = path.join(ctx.artifactDir, "agent-env.sh");
    const marker = `PI_WORKFLOW_ENV_READY_${ctx.contract.attemptId}`;
    const env = {
      PI_WORKFLOW_RUN_ID: ctx.contract.runId,
      PI_WORKFLOW_NODE_ID: ctx.contract.nodeId,
      PI_WORKFLOW_ATTEMPT_ID: ctx.contract.attemptId,
      PI_WORKFLOW_RESULT_PATH: ctx.resultPath,
      PI_WORKFLOW_TASK_PATH: ctx.taskPath,
      PI_WORKFLOW_ARTIFACT_DIR: ctx.artifactDir,
    };
    writeFileSync(
      setupPath,
      `${Object.entries(env)
        .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
        .join("\n")}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await this.client.paneRun(
      paneId,
      `source ${shellQuote(setupPath)} && printf '%s\\n' ${shellQuote(marker)}`,
      signal,
    );
    await this.client.waitOutput(
      paneId,
      marker,
      { timeoutMs: 5_000, source: "recent-unwrapped" },
      signal,
    );
    // wait-output sees the marker before the shell has necessarily reclaimed
    // the foreground process group; agent start requires an available shell.
    await sleep(250, signal);
  }

  /** Wait until the new pane's login shell accepts commands. */
  private async waitForShellReady(paneId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.client.waitOutput(
        paneId,
        "[❯$%#]\\s*$",
        { regex: true, timeoutMs: 5_000, source: "recent-unwrapped" },
        signal,
      );
      // Prompt just appeared; give the shell a beat to finish init hooks.
      await sleep(150, signal);
    } catch {
      // Detection is best-effort. Ceiling: local shells usually paint within
      // ~1s; upgrade: poll process-info once herdr client exposes it.
      await sleep(1_000, signal);
    }
  }
}

function buildValidationRetryPrompt(
  validationError: string,
  submission: number,
  maxSubmissions: number,
): string {
  return [
    "Your previous workflow_done submission was rejected by the workflow validator.",
    `Submission ${submission} of ${maxSubmissions}.`,
    "",
    "Validation error:",
    validationError,
    "",
    "Correct the structured output and call workflow_done again with a valid payload.",
    "Do not reuse the rejected result. result.json was cleared; only a new workflow_done write is authoritative.",
  ].join("\n");
}

function defaultAgentArgs(ctx: AgentStartContext): string[] {
  const args = ["--no-session", "-ne", "-e", ctx.childExtensionPath];
  if (ctx.spawn.model) args.push("--model", ctx.spawn.model);
  if (ctx.thinking) args.push("--thinking", ctx.thinking);
  if (ctx.replaceSystemPrompt) {
    args.push("--system-prompt", ctx.replaceSystemPrompt);
  }
  for (const systemPrompt of ctx.appendSystemPrompts) {
    args.push("--append-system-prompt", systemPrompt);
  }
  if (ctx.spawn.tools) {
    const tools = new Set(ctx.spawn.tools.split(",").map((tool) => tool.trim()).filter(Boolean));
    tools.add("workflow_done");
    args.push("--tools", [...tools].join(","));
  }
  return args;
}

function liveAgentName(label: string, attemptId: string): string {
  const suffix = attemptId.toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 8);
  let base = label.toLowerCase().replaceAll(/[^a-z0-9_-]+/g, "-").replaceAll(/(^-+|-+$)/g, "");
  if (!/^[a-z]/.test(base)) base = `agent-${base}`;
  const maxBaseLength = 32 - suffix.length - 1;
  base = base.slice(0, maxBaseLength).replace(/-+$/, "") || "agent";
  return `${base}-${suffix}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function resolveChildExtensionPath(): string {
  // src/herdr/executor.ts → src/child/extension.ts
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../child/extension.ts");
}

/** Test helper: write a fake successful result as a child would. */
export function writeFakeAgentResult(args: {
  resultPath: string;
  runId: string;
  nodeId: string;
  attemptId: string;
  output: unknown;
}): void {
  mkdirSync(path.dirname(args.resultPath), { recursive: true });
  writeFileSync(
    args.resultPath,
    `${JSON.stringify(
      {
        schema: "pi-herdr-workflows.result.v1",
        runId: args.runId,
        nodeId: args.nodeId,
        attemptId: args.attemptId,
        output: args.output,
        writtenAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
