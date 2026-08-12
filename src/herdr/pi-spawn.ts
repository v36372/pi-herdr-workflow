import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AgentFinishRequest,
  AgentMedium,
  AgentPromptOutcome,
  AgentPromptRequest,
  AgentSession,
  AgentWaitProgress,
} from "../agent/medium.js";
import { AgentProtocolExecutor } from "../agent/protocol.js";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
  ResolvedAgentSpawn,
} from "../workflows/types.js";
import type { AgentStartContext, PiInvocation } from "./pi-args.js";
import {
  buildStandalonePiArgs,
  defaultAgentArgs,
  loadWizEnv,
  resolvePiInvocation,
  workflowChildEnv,
} from "./pi-args.js";

export type SpawnProcessFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export type PiProcessMediumOptions = {
  cwd?: string;
  /** Override how the child `pi` is invoked. Defaults to {@link resolvePiInvocation}. */
  resolvePi?: (args: string[]) => PiInvocation;
  spawnProcess?: SpawnProcessFn;
  buildAgentArgs?: (ctx: AgentStartContext) => string[];
  completionTimeoutMs?: number;
  /** Orchestrator session file used when spawn.fork is true. */
  forkSessionFile?: string;
  /** Extra `-e` sources appended after spawn.extensions (e.g. a stub model). */
  extraChildExtensions?: string[];
  /** Replace spawn.model for the child (test stub provider). */
  modelOverride?: string;
  env?: NodeJS.ProcessEnv;
};

export type PiProcessExecutorOptions = PiProcessMediumOptions & {
  childExtensionPath?: string;
  maxValidationAttempts?: number;
  onProgress?: (event: AgentWaitProgress) => void;
};

export type SpawnLaunchRecord = {
  attempt: number;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  spawn: ResolvedAgentSpawn;
  promptFile: string;
};

/**
 * Vanilla `pi` subprocess medium. Each prompt spawns a print-mode child using
 * the same flags Herdr would pass after `agent start --`.
 */
export class PiProcessMedium implements AgentMedium {
  readonly delivery = "respawn" as const;
  private readonly cwd?: string;
  private readonly resolvePi: (args: string[]) => PiInvocation;
  private readonly spawnProcess: SpawnProcessFn;
  private readonly buildAgentArgs: (ctx: AgentStartContext) => string[];
  private readonly completionTimeoutMs: number;
  private readonly forkSessionFile?: string;
  private readonly extraChildExtensions: string[];
  private readonly modelOverride?: string;
  private readonly env: NodeJS.ProcessEnv;
  private currentChild: ChildProcess | null = null;
  private startContext: AgentStartContext | null = null;
  lastLaunch: SpawnLaunchRecord | null = null;
  launches: SpawnLaunchRecord[] = [];

  constructor(options: PiProcessMediumOptions = {}) {
    this.cwd = options.cwd;
    this.resolvePi = options.resolvePi ?? resolvePiInvocation;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.buildAgentArgs = options.buildAgentArgs ?? defaultAgentArgs;
    this.completionTimeoutMs = options.completionTimeoutMs ?? 30 * 60_000;
    this.forkSessionFile = options.forkSessionFile;
    this.extraChildExtensions = options.extraChildExtensions ?? [];
    this.modelOverride = options.modelOverride;
    this.env = options.env ?? process.env;
  }

  adaptSpawn(spawnConfig: ResolvedAgentSpawn): ResolvedAgentSpawn {
    return applyStandaloneSpawnOverrides(spawnConfig, {
      extraChildExtensions: this.extraChildExtensions,
      modelOverride: this.modelOverride,
    });
  }

  async start(ctx: AgentStartContext, _signal: AbortSignal): Promise<AgentSession> {
    this.startContext = ctx;
    this.launches = [];
    this.lastLaunch = null;
    return {
      agentName: ctx.spawn.name,
      paneId: "pi-process",
      startMessage: `pi spawn ${ctx.spawn.name}`,
    };
  }

  async prompt(_session: AgentSession, request: AgentPromptRequest): Promise<AgentPromptOutcome> {
    const startContext = this.startContext;
    if (!startContext) {
      throw new Error("PiProcessMedium.prompt called before start");
    }
    const childResult = await this.spawnChild({
      startContext: { ...startContext, prompt: request.prompt, taskPath: request.promptFile },
      promptFile: request.promptFile,
      submission: request.submission,
      signal: request.signal,
    });
    if (childResult.killedByAbort) {
      return { killedByAbort: true, detail: formatChildFailure(childResult) };
    }
    return { detail: formatChildFailure(childResult) };
  }

  interrupt(): void {
    this.currentChild?.kill("SIGTERM");
  }

  async finish(_session: AgentSession, _request: AgentFinishRequest): Promise<void> {
    this.currentChild = null;
  }

  private async spawnChild(args: {
    startContext: AgentStartContext;
    promptFile: string;
    submission: number;
    signal: AbortSignal;
  }): Promise<{ code: number | null; stdout: string; stderr: string; killedByAbort: boolean }> {
    const { startContext, promptFile, submission, signal } = args;
    const piArgs = this.buildStandaloneArgs(startContext, promptFile);
    const invocation = this.resolvePi(piArgs);
    const cwd = startContext.spawn.cwd ?? this.cwd ?? process.cwd();
    const childEnv = {
      ...this.env,
      ...(startContext.spawn.kind === "pi-wiz" ? loadWizEnv() : {}),
      ...workflowChildEnv(startContext),
    };
    const record: SpawnLaunchRecord = {
      attempt: submission,
      command: invocation.command,
      args: invocation.args,
      cwd,
      env: workflowChildEnv(startContext),
      spawn: startContext.spawn,
      promptFile,
    };
    this.lastLaunch = record;
    this.launches.push(record);
    writeFileSync(
      path.join(startContext.artifactDir, submission === 1 ? "spawn.json" : `spawn-${submission}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );

    if (signal.aborted) {
      return { code: null, stdout: "", stderr: "", killedByAbort: true };
    }

    return await new Promise((resolve, reject) => {
      const child = this.spawnProcess(invocation.command, invocation.args, {
        cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.currentChild = child;
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, this.completionTimeoutMs);

      const onAbort = () => {
        child.kill("SIGTERM");
      };
      signal.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        this.currentChild = null;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        writeChildLogs(startContext.artifactDir, submission, stdout, stderr);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        this.currentChild = null;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        writeChildLogs(startContext.artifactDir, submission, stdout, stderr);
        resolve({
          code,
          stdout,
          stderr,
          killedByAbort: signal.aborted,
        });
      });
    });
  }

  private buildStandaloneArgs(ctx: AgentStartContext, promptFile: string): string[] {
    const herdrArgs = this.buildAgentArgs(ctx);
    const alreadyPrint = herdrArgs.includes("-p") || herdrArgs.includes("--print");
    if (alreadyPrint) return herdrArgs;
    return buildStandalonePiArgs(ctx, {
      promptFile,
      ...(this.forkSessionFile ? { forkSessionFile: this.forkSessionFile } : {}),
      offline: Boolean(this.modelOverride),
    });
  }
}

/**
 * Agent-step executor that uses a vanilla `pi` subprocess as the medium.
 */
export class PiProcessExecutor implements AgentStepExecutor {
  private readonly medium: PiProcessMedium;
  private readonly protocol: AgentProtocolExecutor;

  constructor(options: PiProcessExecutorOptions = {}) {
    this.medium = new PiProcessMedium(options);
    this.protocol = new AgentProtocolExecutor({
      medium: this.medium,
      cwd: options.cwd,
      childExtensionPath: options.childExtensionPath,
      maxValidationAttempts: options.maxValidationAttempts,
      onProgress: options.onProgress,
    });
  }

  get lastLaunch(): SpawnLaunchRecord | null {
    return this.medium.lastLaunch;
  }

  get launches(): SpawnLaunchRecord[] {
    return this.medium.launches;
  }

  async dispose(signal?: AbortSignal): Promise<void> {
    await this.protocol.dispose(signal);
  }

  async runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission> {
    return await this.protocol.runAgentStep(request, signal);
  }
}

export function applyStandaloneSpawnOverrides(
  spawnConfig: ResolvedAgentSpawn,
  options: { extraChildExtensions: string[]; modelOverride?: string },
): ResolvedAgentSpawn {
  const extensions = [
    ...(spawnConfig.extensions ?? []),
    ...options.extraChildExtensions.filter(
      (extension) => !(spawnConfig.extensions ?? []).includes(extension),
    ),
  ];
  return {
    ...spawnConfig,
    ...(extensions.length > 0 ? { extensions } : {}),
    ...(options.modelOverride ? { model: options.modelOverride } : {}),
  };
}

function writeChildLogs(
  artifactDir: string,
  submission: number,
  stdout: string,
  stderr: string,
): void {
  const suffix = submission === 1 ? "" : `-${submission}`;
  writeFileSync(path.join(artifactDir, `pi-stdout${suffix}.log`), stdout, "utf8");
  writeFileSync(path.join(artifactDir, `pi-stderr${suffix}.log`), stderr, "utf8");
}

function formatChildFailure(result: { code: number | null; stderr: string }): string {
  const parts: string[] = [];
  if (result.code !== 0 && result.code !== null) {
    parts.push(`exit ${result.code}`);
  }
  const err = result.stderr.trim();
  if (err) parts.push(err.slice(0, 500));
  return parts.length ? `; ${parts.join("; ")}` : "";
}
