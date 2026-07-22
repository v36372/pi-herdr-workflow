import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
  ResolvedAgentSpawn,
} from "../workflows/types.js";
import { HerdrClient } from "./client.js";
import {
  ensureArtifactDir,
  readResultFile,
  sleep,
  writeTaskFile,
} from "./result-file.js";

export type HerdrAgentWaitProgress = {
  phase: "launch" | "wait_agent" | "result";
  paneId: string;
  nodeId: string;
  spawnName: string;
  message: string;
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
  /** How to launch the child pi. Receives spawn + paths; returns a shell command. */
  buildLaunchCommand?: (ctx: LaunchContext) => string;
  /** Close the run workspace when the executor is disposed. Default false. */
  closeWorkspaceOnDispose?: boolean;
  /**
   * Max time for herdr wait_agent (idle|done) after launch. Default 30m.
   * Engine abort still wins.
   */
  completionTimeoutMs?: number;
  /** Progress hook for orchestrator UX (herdr wait_agent, etc.). */
  onProgress?: (event: HerdrAgentWaitProgress) => void;
};

export type LaunchContext = {
  spawn: ResolvedAgentSpawn;
  prompt: string;
  contract: AgentStepRequest["contract"];
  taskPath: string;
  resultPath: string;
  exitPath: string;
  artifactDir: string;
  /** Absolute path to this package's child extension entry. */
  childExtensionPath: string;
};

/**
 * Runs agent steps in Herdr panes.
 *
 * Layout:
 * - one workspace per workflow run (created on first agent step, or injected)
 * - one pane per agent attempt, labeled with spawn.name
 * - prompt delivered via `pane run` / launch command + env for result paths
 * Completion path (same primitives as the herdr tool):
 * 1. workspace_create / pane_split / pane run  → launch child
 * 2. wait_agent (idle|done)                   → herdr wait agent-status
 * 3. read result.json from workflow_done
 *
 * Non-agent nodes never reach this executor; the WorkflowEngine runs them
 * in-process on the orchestrator.
 */
export class HerdrStepExecutor implements AgentStepExecutor {
  private readonly client: HerdrClient;
  private readonly cwd?: string;
  private readonly buildLaunchCommand: (ctx: LaunchContext) => string;
  private readonly closeWorkspaceOnDispose: boolean;
  private readonly completionTimeoutMs: number;
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
    this.buildLaunchCommand = options.buildLaunchCommand ?? defaultLaunchCommand;
    this.closeWorkspaceOnDispose = options.closeWorkspaceOnDispose ?? false;
    this.completionTimeoutMs = options.completionTimeoutMs ?? 30 * 60_000;
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
    const { contract, prompt, spawn, accept } = request;
    ensureArtifactDir(contract.artifactDir);
    const taskPath = writeTaskFile(contract.artifactDir, prompt);

    await this.ensureWorkspace(spawn, contract.runId, signal);
    const paneId = await this.allocatePane(spawn, signal);
    const launch = this.buildLaunchCommand({
      spawn,
      prompt,
      contract,
      taskPath,
      resultPath: contract.resultPath,
      exitPath: contract.exitPath,
      artifactDir: contract.artifactDir,
      childExtensionPath: this.childExtensionPath,
    });

    try {
      this.onProgress?.({
        phase: "launch",
        paneId,
        nodeId: contract.nodeId,
        spawnName: spawn.name,
        message: `herdr run ${spawn.name} (${paneId})`,
      });
      // Fresh panes drop/truncate keystrokes until the login shell is ready.
      await this.waitForShellReady(paneId, signal);
      await this.client.paneRun(paneId, launch, signal);

      // Authoritative completion: workflow_done → result.json.
      // herdr agent-status is only a wake-up (child may already be idle shell).
      this.onProgress?.({
        phase: "wait_agent",
        paneId,
        nodeId: contract.nodeId,
        spawnName: spawn.name,
        message: `waiting for workflow_done → ${contract.resultPath}`,
      });
      await this.waitForWorkflowDone(
        paneId,
        contract.resultPath,
        { nodeId: contract.nodeId, spawnName: spawn.name },
        signal,
      );

      this.onProgress?.({
        phase: "result",
        paneId,
        nodeId: contract.nodeId,
        spawnName: spawn.name,
        message: `workflow_done received for ${contract.nodeId}`,
      });
      const output = await this.readAcceptedOutput(request);
      return { output };
    } finally {
      this.lastPaneId = paneId;
    }
  }

  /**
   * Block until the child writes result.json via workflow_done.
   * herdr wait_agent is used as a wake-up only — never as sole success.
   */
  private async waitForWorkflowDone(
    paneId: string,
    resultPath: string,
    meta: { nodeId: string; spawnName: string },
    signal: AbortSignal,
  ): Promise<void> {
    if (readResultFile(resultPath)) return;

    const deadline = Date.now() + this.completionTimeoutMs;
    let sawWorking = false;

    while (!readResultFile(resultPath)) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out after ${this.completionTimeoutMs}ms waiting for workflow_done (${meta.spawnName}) → ${resultPath}`,
        );
      }

      // Slice wait: short agent-status polls so we can re-check the file often.
      // Fresh panes start idle; only treat idle/done as a wake after working.
      const sliceMs = Math.min(5_000, remaining);
      const statuses: Array<"idle" | "working" | "done"> = sawWorking
        ? ["idle", "done", "working"]
        : ["working"];

      const waitAbort = new AbortController();
      const onParentAbort = () => waitAbort.abort(signal.reason);
      signal.addEventListener("abort", onParentAbort, { once: true });
      try {
        await Promise.race([
          this.client.waitAgent(paneId, statuses, sliceMs, waitAbort.signal).then(() => {
            sawWorking = true;
          }),
          (async () => {
            const end = Date.now() + sliceMs;
            while (!readResultFile(resultPath) && Date.now() < end) {
              if (signal.aborted) {
                throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
              }
              await sleep(250, signal);
            }
          })(),
        ]);
      } catch {
        // Timeout on a slice is fine — loop rechecks result.json / deadline.
      } finally {
        signal.removeEventListener("abort", onParentAbort);
        waitAbort.abort();
      }
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

  /**
   * Wait until the pane shell looks ready to accept typed input.
   * Without this, `pane run` of a long line can land as dead text above the
   * first prompt (no Enter / truncated command).
   */
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

  private async readAcceptedOutput(request: AgentStepRequest): Promise<unknown> {
    const { contract, accept } = request;
    const result = readResultFile(contract.resultPath);
    if (!result) {
      throw new Error(
        `Agent went idle without writing result file at ${contract.resultPath}`,
      );
    }

    const accepted = await accept(result.output);
    if (!accepted.ok) {
      // Ceiling: no in-pane validation retry yet. Upgrade: keep pane, re-prompt.
      throw new Error(`Agent output rejected: ${accepted.error}`);
    }
    return accepted.value;
  }
}

function defaultLaunchCommand(ctx: LaunchContext): string {
  // Write a short launcher script instead of typing a 1k+ env+argv line into
  // the pane. Long `pane run` strings race shell init and can sit unexecuted.
  const launchPath = path.join(ctx.artifactDir, "launch.sh");
  const envExports = {
    PI_WORKFLOW_RUN_ID: ctx.contract.runId,
    PI_WORKFLOW_NODE_ID: ctx.contract.nodeId,
    PI_WORKFLOW_ATTEMPT_ID: ctx.contract.attemptId,
    PI_WORKFLOW_RESULT_PATH: ctx.resultPath,
    PI_WORKFLOW_TASK_PATH: ctx.taskPath,
    PI_WORKFLOW_ARTIFACT_DIR: ctx.artifactDir,
  };

  // `-p` = non-interactive: process prompt, exit. That leaves herdr able to
  // report idle/done for wait_agent (interactive + shell return → unknown).
  // `-ne` skips global extensions; explicit `-e` still loads the child tool.
  const args = [
    "pi",
    "--no-session",
    "-p",
    "-ne",
    "-e",
    ctx.childExtensionPath,
  ];
  if (ctx.spawn.model) args.push("--model", ctx.spawn.model);
  if (ctx.spawn.tools) args.push("--tools", ctx.spawn.tools);
  // Skills / agent definition loading is left to pi's discovery + prompt text.
  // Ceiling: no full agent-md frontmatter merge yet. Upgrade: resolve agent
  // defaults the way interactive-subagents does before building argv.

  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    ...Object.entries(envExports).map(
      ([key, value]) => `export ${key}=${shellQuote(value)}`,
    ),
    // `pi` takes positional messages / @files (no `--` separator).
    `exec ${args.map(shellQuote).join(" ")} @${shellQuote(ctx.taskPath)}`,
    "",
  ].join("\n");

  writeFileSync(launchPath, script, { encoding: "utf8", mode: 0o755 });
  return `bash ${shellQuote(launchPath)}`;
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
