import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
  ResolvedAgentSpawn,
} from "../workflows/types.js";
import { preloadSkills, resolveAgentLaunch } from "./agent-defaults.js";
import type { HerdrAgentWaitProgress } from "./executor.js";
import {
  type AgentStartContext,
  type PiInvocation,
  buildMissingResultRetryPrompt,
  buildStandalonePiArgs,
  buildValidationRetryPrompt,
  defaultAgentArgs,
  loadWizEnv,
  resolveChildExtensionPath,
  resolvePiInvocation,
  workflowChildEnv,
  writeAgentEnvScript,
} from "./pi-args.js";
import {
  clearResultFile,
  ensureArtifactDir,
  readResultFile,
  writeTaskFile,
} from "./result-file.js";

export type SpawnProcessFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export type PiProcessExecutorOptions = {
  cwd?: string;
  /** Override how the child `pi` is invoked. Defaults to {@link resolvePiInvocation}. */
  resolvePi?: (args: string[]) => PiInvocation;
  spawnProcess?: SpawnProcessFn;
  buildAgentArgs?: (ctx: AgentStartContext) => string[];
  childExtensionPath?: string;
  completionTimeoutMs?: number;
  maxValidationAttempts?: number;
  onProgress?: (event: HerdrAgentWaitProgress) => void;
  /** Orchestrator session file used when spawn.fork is true. */
  forkSessionFile?: string;
  /** Extra `-e` sources appended after spawn.extensions (e.g. a stub model). */
  extraChildExtensions?: string[];
  /** Replace spawn.model for the child (test stub provider). */
  modelOverride?: string;
  env?: NodeJS.ProcessEnv;
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
 * Runs agent steps as standalone vanilla `pi` child processes.
 *
 * Used when the orchestrator is not inside Herdr. Spawn params map to the same
 * `pi` flags as Herdr's `agent start ... --` payload, plus print-mode flags so
 * the child exits after `workflow_done`.
 */
export class PiProcessExecutor implements AgentStepExecutor {
  private readonly cwd?: string;
  private readonly resolvePi: (args: string[]) => PiInvocation;
  private readonly spawnProcess: SpawnProcessFn;
  private readonly buildAgentArgs: (ctx: AgentStartContext) => string[];
  private readonly childExtensionPath: string;
  private readonly completionTimeoutMs: number;
  private readonly maxValidationAttempts: number;
  private readonly onProgress?: (event: HerdrAgentWaitProgress) => void;
  private readonly forkSessionFile?: string;
  private readonly extraChildExtensions: string[];
  private readonly modelOverride?: string;
  private readonly env: NodeJS.ProcessEnv;
  lastLaunch: SpawnLaunchRecord | null = null;
  launches: SpawnLaunchRecord[] = [];

  constructor(options: PiProcessExecutorOptions = {}) {
    this.cwd = options.cwd;
    this.resolvePi = options.resolvePi ?? resolvePiInvocation;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.buildAgentArgs = options.buildAgentArgs ?? defaultAgentArgs;
    this.childExtensionPath = options.childExtensionPath ?? resolveChildExtensionPath();
    this.completionTimeoutMs = options.completionTimeoutMs ?? 30 * 60_000;
    this.maxValidationAttempts = Math.max(1, options.maxValidationAttempts ?? 3);
    this.onProgress = options.onProgress;
    this.forkSessionFile = options.forkSessionFile;
    this.extraChildExtensions = options.extraChildExtensions ?? [];
    this.modelOverride = options.modelOverride;
    this.env = options.env ?? process.env;
  }

  async dispose(): Promise<void> {
    // No pane/workspace to tear down.
  }

  async runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission> {
    const { contract } = request;
    ensureArtifactDir(contract.artifactDir);
    clearResultFile(contract.resultPath);
    const launch = resolveAgentLaunch(request.spawn, this.cwd);
    const spawnConfig = applyStandaloneSpawnOverrides(launch.spawn, {
      extraChildExtensions: this.extraChildExtensions,
      modelOverride: this.modelOverride,
    });
    const rolePrompt = launch.rolePrompt
      ? `${launch.rolePrompt}\n\n${request.prompt}`
      : request.prompt;
    const prompt = await preloadSkills(
      rolePrompt,
      spawnConfig.skills,
      spawnConfig.cwd ?? this.cwd ?? process.cwd(),
    );
    const taskPath = writeTaskFile(contract.artifactDir, prompt);
    const startContext: AgentStartContext = {
      spawn: spawnConfig,
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

    const agentName = spawnConfig.name;
    const paneId = "pi-process";
    this.onProgress?.({
      phase: "agent_start",
      paneId,
      agentName,
      nodeId: contract.nodeId,
      spawnName: spawnConfig.name,
      message: `pi spawn ${agentName} (standalone)`,
    });

    let nextPrompt = prompt;
    let nextPromptFile = taskPath;
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
        spawnName: spawnConfig.name,
        message:
          submission === 1
            ? `pi -p ${agentName}`
            : lastFailure?.kind === "missing_result"
              ? `missing workflow_done; respawn ${agentName} (${submission}/${this.maxValidationAttempts})`
              : `validation rejected; respawn ${agentName} (${submission}/${this.maxValidationAttempts})`,
        submission,
        maxSubmissions: this.maxValidationAttempts,
      });

      if (submission > 1) {
        nextPromptFile = path.join(contract.artifactDir, `retry-${submission}.md`);
        writeFileSync(nextPromptFile, nextPrompt, "utf8");
      }

      clearResultFile(contract.resultPath);
      const childResult = await this.spawnChild({
        startContext: { ...startContext, prompt: nextPrompt, taskPath: nextPromptFile },
        promptFile: nextPromptFile,
        submission,
        signal,
      });
      if (childResult.killedByAbort) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
      }

      const hasResult = Boolean(readResultFile(contract.resultPath));
      if (!hasResult) {
        lastFailure = {
          kind: "missing_result",
          message: `Agent ${spawnConfig.name} settled without calling workflow_done (${contract.resultPath})${formatChildFailure(childResult)}`,
        };
        if (submission >= this.maxValidationAttempts) break;
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
          spawnName: spawnConfig.name,
          message: `workflow_done accepted for ${contract.nodeId}`,
          submission,
          maxSubmissions: this.maxValidationAttempts,
        });
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
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        writeChildLogs(startContext.artifactDir, submission, stdout, stderr);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
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

export function applyStandaloneSpawnOverrides(
  spawn: ResolvedAgentSpawn,
  options: { extraChildExtensions: string[]; modelOverride?: string },
): ResolvedAgentSpawn {
  const extensions = [
    ...(spawn.extensions ?? []),
    ...options.extraChildExtensions.filter(
      (extension) => !(spawn.extensions ?? []).includes(extension),
    ),
  ];
  return {
    ...spawn,
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
