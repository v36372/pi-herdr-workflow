import type { AgentStartContext } from "../herdr/pi-args.js";
import type { ResolvedAgentSpawn } from "../workflows/types.js";

/**
 * How an agent is started, prompted, and waited on.
 *
 * The workflow engine never talks to a medium directly. {@link AgentProtocolExecutor}
 * owns skills, `task.md`, `result.json`, and validation retries. A medium only
 * delivers prompts and reports when the child has settled.
 *
 * Herdr panes, a vanilla `pi` subprocess, and a test mock are all media.
 * Tests should mock this surface rather than requiring a live Herdr.
 */
export interface AgentMedium {
  /**
   * `live` re-prompts the same child (Herdr pane). `respawn` starts a new
   * child per submission (subprocess `pi`).
   */
  readonly delivery: "live" | "respawn";

  /** Optional spawn rewrite before skills/task files are prepared (stub model, extra `-e`). */
  adaptSpawn?(spawn: ResolvedAgentSpawn): ResolvedAgentSpawn;

  /** Allocate a session and start the child. Env/task files are already on disk. */
  start(ctx: AgentStartContext, signal: AbortSignal): Promise<AgentSession>;

  /** Deliver one prompt and wait until the child settles (or abort). */
  prompt(session: AgentSession, request: AgentPromptRequest): Promise<AgentPromptOutcome>;

  /** Best-effort stop when the engine aborts the step. */
  interrupt?(session: AgentSession): void;

  /** After an accepted `workflow_done` (e.g. close a pane). */
  finish?(
    session: AgentSession,
    request: AgentFinishRequest,
  ): Promise<void>;

  /** Always run after a step, including failures (restore focus, update layout). */
  afterStep?(session: AgentSession, signal: AbortSignal): Promise<void>;

  dispose?(signal?: AbortSignal): Promise<void>;
}

export type AgentSession = {
  agentName: string;
  /** Herdr pane id, or a stand-in such as `pi-process` / `mock`. */
  paneId: string;
  /** Progress line for the start phase. */
  startMessage?: string;
};

export type AgentPromptRequest = {
  prompt: string;
  /** `task.md` on the first submission, `retry-N.md` after that. */
  promptFile: string;
  submission: number;
  signal: AbortSignal;
};

export type AgentPromptOutcome = {
  killedByAbort?: boolean;
  /** Appended to the missing-`workflow_done` error (child stderr, exit code). */
  detail?: string;
};

export type AgentFinishRequest = {
  spawn: ResolvedAgentSpawn;
  signal: AbortSignal;
};

export type AgentWaitProgress = {
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
