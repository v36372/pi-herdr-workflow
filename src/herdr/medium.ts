import type {
  AgentFinishRequest,
  AgentMedium,
  AgentPromptOutcome,
  AgentPromptRequest,
  AgentSession,
  AgentWaitProgress,
} from "../agent/medium.js";
import type { ResolvedAgentSpawn } from "../workflows/types.js";
import { HerdrClient, isHerdrError, makeHerdrError } from "./client.js";
import {
  type AgentStartContext,
  defaultAgentArgs,
  resolveHerdrKind,
  shellQuote,
  writeAgentEnvScript,
} from "./pi-args.js";
import { readResultFile, sleep } from "./result-file.js";

export type HerdrOriginFocus = {
  workspaceId?: string;
  tabId?: string;
};

export type HerdrMediumOptions = {
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
  /**
   * Tear down run-owned layout on dispose: close an owned tab, or an owned
   * fallback workspace. Default false.
   */
  closeWorkspaceOnDispose?: boolean;
  /** Max time for `agent prompt --wait`. Default 30m. Engine abort still wins. */
  completionTimeoutMs?: number;
  /** Progress hook for blocked-agent waits (protocol emits the other phases). */
  onProgress?: (event: AgentWaitProgress) => void;
};

/**
 * Herdr pane medium: workspace/tab/pane allocation, `agent start`, and
 * `agent prompt --wait`. Protocol (result.json / retries) lives elsewhere.
 */
export class HerdrMedium implements AgentMedium {
  readonly delivery = "live" as const;
  private readonly client: HerdrClient;
  private readonly cwd?: string;
  private readonly originFocus: HerdrOriginFocus;
  private readonly buildAgentArgs: (ctx: AgentStartContext) => string[];
  private readonly closeWorkspaceOnDispose: boolean;
  private readonly completionTimeoutMs: number;
  private readonly onProgress?: (event: AgentWaitProgress) => void;
  private workspaceId: string | null;
  private runTabId: string | null = null;
  private ownsWorkspace = false;
  private ownsTab = false;
  private rootPaneId: string | null = null;
  private lastPaneId: string | null = null;
  private hasUsedRoot = false;
  private closedPane = false;
  private activeStart: AgentStartContext | null = null;

  constructor(options: HerdrMediumOptions = {}) {
    this.client = options.client ?? new HerdrClient();
    this.cwd = options.cwd;
    this.workspaceId = options.workspaceId ?? null;
    this.originFocus = resolveOriginFocus(options.originFocus);
    this.buildAgentArgs = options.buildAgentArgs ?? defaultAgentArgs;
    this.closeWorkspaceOnDispose = options.closeWorkspaceOnDispose ?? false;
    this.completionTimeoutMs = options.completionTimeoutMs ?? 30 * 60_000;
    this.onProgress = options.onProgress;
  }

  get runWorkspaceId(): string | null {
    return this.workspaceId;
  }

  get runTabIdValue(): string | null {
    return this.runTabId;
  }

  async start(ctx: AgentStartContext, signal: AbortSignal): Promise<AgentSession> {
    this.activeStart = ctx;
    this.closedPane = false;
    const { spawn, contract } = ctx;
    await this.ensureWorkspace(spawn, contract.runId, signal);
    const paneId = await this.allocatePane(spawn, signal);
    const herdrKind = resolveHerdrKind(spawn.kind);
    const kindNote =
      spawn.kind && spawn.kind !== herdrKind ? ` (workflow kind ${spawn.kind})` : "";
    const agentName = liveAgentName(spawn.name, contract.attemptId);
    const session: AgentSession = {
      agentName,
      paneId,
      startMessage: `herdr agent start ${agentName} --kind ${herdrKind} --pane ${paneId}${kindNote}`,
    };
    const onAbort = (): void => {
      this.interrupt(session);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      await this.prepareAgentEnvironment(paneId, ctx, signal);
      try {
        await this.client.agentStart(
          {
            name: agentName,
            kind: herdrKind,
            paneId,
            args: this.buildAgentArgs(ctx),
          },
          signal,
        );
      } catch (error) {
        throw this.mapAgentControlError(error, agentName, "start");
      }
      return session;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async prompt(session: AgentSession, request: AgentPromptRequest): Promise<AgentPromptOutcome> {
    const ctx = this.activeStart;
    if (!ctx) {
      throw new Error("HerdrMedium.prompt called before start");
    }
    try {
      await this.client.agentPrompt(
        session.agentName,
        request.prompt,
        { wait: true, timeoutMs: this.completionTimeoutMs },
        request.signal,
      );
    } catch (error) {
      throw this.mapAgentControlError(error, session.agentName, "prompt");
    }
    await this.waitForWorkflowDone(session, ctx, request.signal);
    return { killedByAbort: request.signal.aborted };
  }

  interrupt(session: AgentSession): void {
    void this.client.agentSendKeys(session.agentName, ["Escape"]).catch(() => undefined);
  }

  async finish(session: AgentSession, request: AgentFinishRequest): Promise<void> {
    if (request.spawn.closePaneAfterDone && session.paneId !== this.rootPaneId) {
      try {
        await this.client.paneClose(session.paneId, request.signal);
        this.closedPane = true;
      } catch {
        // Best-effort; run layout cleanup still happens on dispose.
      }
    }
  }

  async afterStep(session: AgentSession, signal: AbortSignal): Promise<void> {
    this.lastPaneId = this.closedPane ? this.rootPaneId : session.paneId;
    this.activeStart = null;
    await this.restoreOriginFocus(signal);
  }

  async dispose(signal?: AbortSignal): Promise<void> {
    if (!this.closeWorkspaceOnDispose) return;
    const closingTabId = this.ownsTab ? this.runTabId : null;
    const closingWorkspaceId = this.ownsWorkspace ? this.workspaceId : null;
    if (!closingTabId && !closingWorkspaceId) return;
    try {
      await this.restoreOriginFocus(signal);
      if (closingTabId) {
        await this.client.tabClose(closingTabId, signal);
      } else if (closingWorkspaceId) {
        await this.client.workspaceClose(closingWorkspaceId, signal);
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

  private async restoreOriginFocus(signal?: AbortSignal): Promise<void> {
    const originWorkspace = this.originFocus.workspaceId;
    const originTab = this.originFocus.tabId;
    if (!originWorkspace && !originTab) return;
    if (this.ownsWorkspace && originWorkspace && originWorkspace === this.workspaceId) {
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

  /**
   * `agent prompt --wait` is the lifecycle signal; result.json is authoritative.
   * Handles a blocked agent by waiting for idle/done.
   */
  private async waitForWorkflowDone(
    session: AgentSession,
    ctx: AgentStartContext,
    signal: AbortSignal,
  ): Promise<void> {
    if (readResultFile(ctx.resultPath)) return;

    let agent;
    try {
      agent = await this.client.agentGet(session.agentName, signal);
    } catch (error) {
      throw this.mapAgentControlError(error, session.agentName, "get");
    }

    if (agent.agent_status === "blocked") {
      this.onProgress?.({
        phase: "blocked",
        paneId: session.paneId,
        agentName: session.agentName,
        nodeId: ctx.contract.nodeId,
        spawnName: ctx.spawn.name,
        message: `${session.agentName} is blocked; waiting for user input`,
      });
      try {
        await this.client.agentWait(
          session.agentName,
          ["idle", "done"],
          this.completionTimeoutMs,
          signal,
        );
      } catch (error) {
        throw this.mapAgentControlError(error, session.agentName, "wait");
      }
    }
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
      const panes = await this.client.paneList(this.workspaceId, signal);
      this.rootPaneId = panes[0]?.pane_id ?? null;
      this.lastPaneId = this.rootPaneId;
      return;
    }

    const label = `wf:${runId}`.slice(0, 48);
    const cwd = spawn.cwd ?? this.cwd;
    const hostWorkspace = this.originFocus.workspaceId;

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
    await sleep(250, signal);
  }

  private async waitForShellReady(paneId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.client.waitOutput(
        paneId,
        "[❯$%#]\\s*$",
        { regex: true, timeoutMs: 5_000, source: "recent-unwrapped" },
        signal,
      );
      await sleep(150, signal);
    } catch {
      await sleep(1_000, signal);
    }
  }
}

function resolveOriginFocus(explicit?: HerdrOriginFocus): HerdrOriginFocus {
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
