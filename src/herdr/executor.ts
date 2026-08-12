import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
  ResolvedAgentSpawn,
} from "../workflows/types.js";
import { preloadSkills, resolveAgentLaunch } from "./agent-defaults.js";
import { HerdrClient, isHerdrError, makeHerdrError } from "./client.js";
import {
  type AgentStartContext,
  buildMissingResultRetryPrompt,
  buildValidationRetryPrompt,
  defaultAgentArgs,
  resolveChildExtensionPath,
  resolveHerdrKind,
  shellQuote,
  writeAgentEnvScript,
} from "./pi-args.js";
import {
  clearResultFile,
  ensureArtifactDir,
  readResultFile,
  sleep,
  writeTaskFile,
} from "./result-file.js";

export type { AgentStartContext } from "./pi-args.js";
export {
  buildKindBootstrapLines,
  defaultAgentArgs,
  isInsideHerdr,
  resolveHerdrKind,
} from "./pi-args.js";

/** Explicit ceiling for same-pane validation resubmissions (initial + retries). */
export const DEFAULT_MAX_VALIDATION_ATTEMPTS = 3;

export type HerdrAgentWaitProgress = {
  phase:
    | "agent_start"
    | "agent_prompt"
    | "blocked"
    | "completion_retry"
    | "validation_retry"
    | "result";
  paneId: string;
  agentName: string;
  nodeId: string;
  spawnName: string;
  message: string;
  submission?: number;
  maxSubmissions?: number;
};

export type HerdrOriginFocus = {
  workspaceId?: string;
  tabId?: string;
};

export type HerdrStepExecutorOptions = {
  client?: HerdrClient;
  /**
   * Existing workspace to host agent panes. When omitted, the first agent step
   * prefers a tab in the orchestrator workspace (`originFocus.workspaceId` /
   * `HERDR_WORKSPACE_ID`), and only creates a separate workspace as fallback.
   */
  workspaceId?: string;
  /** cwd for newly created workspaces / panes. */
  cwd?: string;
  /**
   * Orchestrator focus to restore after agent steps / dispose cleanup.
   * Defaults to `HERDR_WORKSPACE_ID` / `HERDR_TAB_ID` when present.
   */
  originFocus?: HerdrOriginFocus;
  /** Build native arguments passed after `herdr agent start ... --`. */
  buildAgentArgs?: (ctx: AgentStartContext) => string[];
  /** Override the child `workflow_done` extension path. */
  childExtensionPath?: string;
  /**
   * Tear down run-owned layout on dispose: close an owned tab, or an owned
   * fallback workspace. Default false.
   */
  closeWorkspaceOnDispose?: boolean;
  /** Max time for `agent prompt --wait`. Default 30m. Engine abort still wins. */
  completionTimeoutMs?: number;
  /**
   * Max prompt/settle cycles for one agent step, including the first attempt.
   * Covers both missing `workflow_done` and validator rejections. Each failure
   * re-prompts the same live agent until this ceiling. Default 3.
   */
  maxValidationAttempts?: number;
  /** Progress hook for orchestrator tool updates. */
  onProgress?: (event: HerdrAgentWaitProgress) => void;
};

/**
 * Runs agent steps in Herdr panes.
 *
 * Layout:
 * - prefer one tab in the orchestrator workspace (avoids Herdr focus jumps
 *   that happen when a whole workspace is closed)
 * - fallback: one workspace per run when no origin workspace is known
 * - one pane per agent attempt, labeled with spawn.name
 * - environment prepared in the pane shell before Herdr starts interactive pi
 * Completion path:
 * 1. tab/workspace + pane allocation
 * 2. `herdr agent start ... --kind pi` validates interactive readiness
 *    (`spawn.kind: "pi-wiz"` still uses Herdr kind `pi`, after sourcing Wiz env
 *    and loading `pi-mcp-adapter` so the `mcp` tool exists)
 * 3. `herdr agent prompt ... --wait` blocks on a lifecycle signal
 * 4. read authoritative result.json written by workflow_done
 * 5. if the agent settles with no result.json, re-prompt the same agent
 * 6. on validation rejection, clear result.json and re-prompt the same agent
 */
export class HerdrStepExecutor implements AgentStepExecutor {
  private readonly client: HerdrClient;
  private readonly cwd?: string;
  private readonly originFocus: HerdrOriginFocus;
  private readonly buildAgentArgs: (ctx: AgentStartContext) => string[];
  private readonly closeWorkspaceOnDispose: boolean;
  private readonly completionTimeoutMs: number;
  private readonly maxValidationAttempts: number;
  private readonly onProgress?: (event: HerdrAgentWaitProgress) => void;
  private readonly childExtensionPath: string;
  private workspaceId: string | null;
  private runTabId: string | null = null;
  private ownsWorkspace = false;
  private ownsTab = false;
  private rootPaneId: string | null = null;
  private lastPaneId: string | null = null;

  constructor(options: HerdrStepExecutorOptions = {}) {
    this.client = options.client ?? new HerdrClient();
    this.cwd = options.cwd;
    this.workspaceId = options.workspaceId ?? null;
    this.originFocus = resolveOriginFocus(options.originFocus);
    this.buildAgentArgs = options.buildAgentArgs ?? defaultAgentArgs;
    this.closeWorkspaceOnDispose = options.closeWorkspaceOnDispose ?? false;
    this.completionTimeoutMs = options.completionTimeoutMs ?? 30 * 60_000;
    this.maxValidationAttempts = Math.max(1, options.maxValidationAttempts ?? DEFAULT_MAX_VALIDATION_ATTEMPTS);
    this.onProgress = options.onProgress;
    this.childExtensionPath = options.childExtensionPath ?? resolveChildExtensionPath();
  }

  get runWorkspaceId(): string | null {
    return this.workspaceId;
  }

  get runTabIdValue(): string | null {
    return this.runTabId;
  }

  async dispose(signal?: AbortSignal): Promise<void> {
    if (!this.closeWorkspaceOnDispose) return;
    const closingTabId = this.ownsTab ? this.runTabId : null;
    const closingWorkspaceId = this.ownsWorkspace ? this.workspaceId : null;
    if (!closingTabId && !closingWorkspaceId) return;
    try {
      // Always put the user back on the orchestrator before tearing layout down.
      // Closing a non-focused *workspace* still reassigns Herdr's focused
      // workspace to an arbitrary neighbor; tab close does not.
      await this.restoreOriginFocus(signal);
      if (closingTabId) {
        await this.client.tabClose(closingTabId, signal);
      } else if (closingWorkspaceId) {
        await this.client.workspaceClose(closingWorkspaceId, signal);
        // workspace.close can still flip the focused workspace flag even when
        // we restored first; restore again so the UI settles on origin.
        await this.restoreOriginFocus(signal);
      }
    } catch {
      // Best effort.
    } finally {
      this.workspaceId = null;
      this.runTabId = null;
      this.ownsWorkspace = false;
      this.ownsTab = false;
      this.rootPaneId = null;
      this.lastPaneId = null;
    }
  }

  /** Best-effort return to the pane/workspace that launched the workflow. */
  private async restoreOriginFocus(signal?: AbortSignal): Promise<void> {
    const originWorkspace = this.originFocus.workspaceId;
    const originTab = this.originFocus.tabId;
    if (!originWorkspace && !originTab) return;
    // Never focus a fallback workspace we are about to destroy.
    if (
      this.ownsWorkspace &&
      originWorkspace &&
      originWorkspace === this.workspaceId
    ) {
      return;
    }
    try {
      if (originWorkspace) {
        await this.client.workspaceFocus(originWorkspace, signal);
      }
      if (originTab) {
        await this.client.tabFocus(originTab, signal);
      }
    } catch {
      // Cosmetic: dispose/close must still proceed.
    }
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
    let closedPane = false;
    let interruptRequested = false;

    const interruptAgent = (): void => {
      if (interruptRequested) return;
      interruptRequested = true;
      // Best-effort: stop the live child so a timed-out/cancelled attempt cannot
      // keep working after the engine has closed the step.
      void this.client.agentSendKeys(agentName, ["Escape"]).catch(() => undefined);
    };
    signal.addEventListener("abort", interruptAgent, { once: true });
    if (signal.aborted) {
      interruptAgent();
    }

    try {
      await this.prepareAgentEnvironment(paneId, startContext, signal);
      const herdrKind = resolveHerdrKind(spawn.kind);
      const kindNote =
        spawn.kind && spawn.kind !== herdrKind ? ` (workflow kind ${spawn.kind})` : "";
      this.onProgress?.({
        phase: "agent_start",
        paneId,
        agentName,
        nodeId: contract.nodeId,
        spawnName: spawn.name,
        message: `herdr agent start ${agentName} --kind ${herdrKind} --pane ${paneId}${kindNote}`,
      });
      try {
        await this.client.agentStart(
          {
            name: agentName,
            kind: herdrKind,
            paneId,
            args: this.buildAgentArgs(startContext),
          },
          signal,
        );
      } catch (error) {
        throw this.mapAgentControlError(error, agentName, "start");
      }

      let nextPrompt = prompt;
      let lastFailure: { kind: "missing_result" | "validation"; message: string } | null = null;
      for (let submission = 1; submission <= this.maxValidationAttempts; submission++) {
        const retryPhase =
          lastFailure?.kind === "missing_result"
            ? "completion_retry"
            : lastFailure?.kind === "validation"
              ? "validation_retry"
              : "agent_prompt";
        this.onProgress?.({
          phase: submission === 1 ? "agent_prompt" : retryPhase,
          paneId,
          agentName,
          nodeId: contract.nodeId,
          spawnName: spawn.name,
          message:
            submission === 1
              ? `herdr agent prompt ${agentName} --wait`
              : lastFailure?.kind === "missing_result"
                ? `missing workflow_done; re-prompt ${agentName} (${submission}/${this.maxValidationAttempts})`
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
        const hasResult = await this.waitForWorkflowDone(
          agentName,
          paneId,
          contract.resultPath,
          { nodeId: contract.nodeId, spawnName: spawn.name },
          signal,
        );
        if (!hasResult) {
          lastFailure = {
            kind: "missing_result",
            message: `Agent ${spawn.name} settled without calling workflow_done (${contract.resultPath})`,
          };
          if (submission >= this.maxValidationAttempts) break;
          // Keep task.md as the original submitted task; retries only re-prompt live.
          nextPrompt = buildMissingResultRetryPrompt(submission, this.maxValidationAttempts);
          continue;
        }

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
          // Opt-in: close the agent pane after a successful submission so
          // collaborative workflows can leave panes open by default.
          if (spawn.closePaneAfterDone && paneId !== this.rootPaneId) {
            try {
              await this.client.paneClose(paneId, signal);
              closedPane = true;
            } catch {
              // Best-effort; run layout cleanup still happens on dispose.
            }
          }
          return { output: accepted.value };
        }

        lastFailure = { kind: "validation", message: accepted.error };
        clearResultFile(contract.resultPath);
        if (submission >= this.maxValidationAttempts) break;
        // Keep task.md as the original submitted task; retries only re-prompt live.
        nextPrompt = buildValidationRetryPrompt(accepted.error, submission, this.maxValidationAttempts);
      }

      if (lastFailure?.kind === "missing_result") {
        throw new Error(
          `${lastFailure.message} after ${this.maxValidationAttempts} submission(s)`,
        );
      }
      throw new Error(
        `Agent output rejected after ${this.maxValidationAttempts} submission(s): ${lastFailure?.message ?? "unknown validation error"}`,
      );
    } finally {
      signal.removeEventListener("abort", interruptAgent);
      this.lastPaneId = closedPane ? this.rootPaneId : paneId;
      // agent.start can steal UI focus into the run workspace; put the user
      // back on the orchestrator between steps and before dispose/close.
      await this.restoreOriginFocus(signal);
    }
  }

  /**
   * `agent prompt --wait` is the lifecycle signal; result.json is authoritative.
   * Returns true when workflow_done wrote a result. Returns false when the agent
   * settled without one so the caller can re-prompt within the attempt ceiling.
   */
  private async waitForWorkflowDone(
    agentName: string,
    paneId: string,
    resultPath: string,
    meta: { nodeId: string; spawnName: string },
    signal: AbortSignal,
  ): Promise<boolean> {
    if (readResultFile(resultPath)) return true;

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
      if (readResultFile(resultPath)) return true;
    }

    return false;
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
        return makeHerdrError(
          error.code,
          `Herdr protocol mismatch while ${operation}ing agent ${agentName}. Upgrade Herdr/pi-herdr-workflows so CLI and server agree. ${error.message}`,
          { args: error.args, exitCode: error.exitCode, id: error.id },
        );
      case "agent_prompt_stalled":
        return makeHerdrError(
          error.code,
          `Agent ${agentName} did not begin working after prompt submission (agent_prompt_stalled). The pane may be blocked on a prompt, offline, or not accepting input. ${error.message}`,
          { args: error.args, exitCode: error.exitCode, id: error.id },
        );
      case "agent_not_running":
        return makeHerdrError(
          error.code,
          `Agent ${agentName} is no longer running in its pane (agent_not_running) during ${operation}. ${error.message}`,
          { args: error.args, exitCode: error.exitCode, id: error.id },
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
    if (this.workspaceId && this.rootPaneId) return;
    if (this.workspaceId && !this.rootPaneId) {
      // Injected workspace without a known root pane: pick any pane as split source.
      const panes = await this.client.paneList(this.workspaceId, signal);
      this.rootPaneId = panes[0]?.pane_id ?? null;
      this.lastPaneId = this.rootPaneId;
      return;
    }

    const label = `wf:${runId}`.slice(0, 48);
    const cwd = spawn.cwd ?? this.cwd;
    const hostWorkspace = this.originFocus.workspaceId;

    // Prefer a tab inside the orchestrator workspace. Closing a tab does not
    // reassign Herdr's focused workspace the way workspace.close does.
    if (hostWorkspace) {
      const tab = await this.client.tabCreate(
        {
          workspaceId: hostWorkspace,
          cwd,
          label,
          focus: false,
        },
        signal,
      );
      this.workspaceId = tab.workspace_id ?? hostWorkspace;
      this.runTabId = tab.tab_id;
      this.ownsTab = true;
      this.ownsWorkspace = false;
      this.rootPaneId = tab.pane_id ?? null;
      this.lastPaneId = this.rootPaneId;
      return;
    }

    // No known orchestrator workspace (e.g. tests / non-Herdr host): fallback.
    const created = await this.client.workspaceCreate(
      {
        cwd,
        label,
        focus: false,
      },
      signal,
    );
    this.workspaceId = created.workspace_id;
    this.ownsWorkspace = true;
    this.ownsTab = false;
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
    if (
      this.lastPaneId === this.rootPaneId &&
      (this.ownsWorkspace || this.ownsTab) &&
      !this.hasUsedRoot
    ) {
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
    const setupPath = writeAgentEnvScript(ctx);
    const marker = `PI_WORKFLOW_ENV_READY_${ctx.contract.attemptId}`;
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

function resolveOriginFocus(explicit?: HerdrOriginFocus): HerdrOriginFocus {
  // Explicit object (even empty) wins so unit tests are not polluted by a live
  // HERDR_* environment. Env is only the default when the caller omits the field.
  if (explicit) {
    return {
      ...(explicit.workspaceId ? { workspaceId: explicit.workspaceId } : {}),
      ...(explicit.tabId ? { tabId: explicit.tabId } : {}),
    };
  }
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  const tabId = process.env.HERDR_TAB_ID;
  return {
    ...(workspaceId ? { workspaceId } : {}),
    ...(tabId ? { tabId } : {}),
  };
}

function liveAgentName(label: string, attemptId: string): string {
  const suffix = attemptId.toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 8);
  let base = label.toLowerCase().replaceAll(/[^a-z0-9_-]+/g, "-").replaceAll(/(^-+|-+$)/g, "");
  if (!/^[a-z]/.test(base)) base = `agent-${base}`;
  const maxBaseLength = 32 - suffix.length - 1;
  base = base.slice(0, maxBaseLength).replace(/-+$/, "") || "agent";
  return `${base}-${suffix}`;
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
