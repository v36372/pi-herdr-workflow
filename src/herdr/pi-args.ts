import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentStepRequest,
  ResolvedAgentSpawn,
  WorkflowAgentKind,
} from "../workflows/types.js";

/** Package source accepted by `pi -e` (resolved via package-manager, incl. git URLs). */
export const PI_MCP_ADAPTER_SOURCE = "https://github.com/nicobailon/pi-mcp-adapter";

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

export type PiInvocation = {
  command: string;
  args: string[];
};

/** True when the current process is a pi running inside a Herdr pane. */
export function isInsideHerdr(): boolean {
  return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_PANE_ID);
}

/**
 * Map workflow spawn.kind → Herdr `--kind`.
 * Herdr only accepts a fixed agent enum; `pi-wiz` is a pi wrapper with env bootstrap.
 */
export function resolveHerdrKind(kind: WorkflowAgentKind | undefined): "pi" {
  if (kind === undefined || kind === "pi" || kind === "pi-wiz") {
    return "pi";
  }
  const _exhaustive: never = kind;
  throw new Error(`Unsupported workflow agent kind: ${String(_exhaustive)}`);
}

/** Shell lines sourced before agent start for kind-specific env bootstrap. */
export function buildKindBootstrapLines(kind: WorkflowAgentKind | undefined): string[] {
  if (kind !== "pi-wiz") {
    return [];
  }
  const wizEnv = path.join(os.homedir(), ".config", "wiz-mcp", "env.zsh");
  return [
    "# workflow spawn.kind=pi-wiz → load Wiz MCP credentials (same as shell alias pi-wiz)",
    `if [ -f ${shellQuote(wizEnv)} ]; then`,
    "  set -a",
    `  . ${shellQuote(wizEnv)}`,
    "  set +a",
    "fi",
  ];
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function workflowChildEnv(ctx: AgentStartContext): Record<string, string> {
  return {
    PI_WORKFLOW_RUN_ID: ctx.contract.runId,
    PI_WORKFLOW_NODE_ID: ctx.contract.nodeId,
    PI_WORKFLOW_ATTEMPT_ID: ctx.contract.attemptId,
    PI_WORKFLOW_RESULT_PATH: ctx.resultPath,
    PI_WORKFLOW_TASK_PATH: ctx.taskPath,
    PI_WORKFLOW_ARTIFACT_DIR: ctx.artifactDir,
  };
}

export function writeAgentEnvScript(ctx: AgentStartContext): string {
  const setupPath = path.join(ctx.artifactDir, "agent-env.sh");
  const lines = [
    ...Object.entries(workflowChildEnv(ctx)).map(
      ([key, value]) => `export ${key}=${shellQuote(value)}`,
    ),
    ...buildKindBootstrapLines(ctx.spawn.kind),
  ];
  writeFileSync(setupPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  return setupPath;
}

/**
 * Native `pi` arguments after `herdr agent start ... --`.
 * Settings discovery is off (`-ne`); explicit `-e` sources still load.
 */
export function defaultAgentArgs(ctx: AgentStartContext): string[] {
  const args = ["--no-session", "-ne", "-e", ctx.childExtensionPath];
  for (const extension of ctx.spawn.extensions ?? []) {
    args.push("-e", extension);
  }
  if (ctx.spawn.kind === "pi-wiz") {
    args.push("-e", PI_MCP_ADAPTER_SOURCE);
  }
  if (ctx.spawn.model) args.push("--model", ctx.spawn.model);
  if (ctx.thinking) args.push("--thinking", ctx.thinking);
  if (ctx.replaceSystemPrompt) {
    args.push("--system-prompt", ctx.replaceSystemPrompt);
  }
  for (const systemPrompt of ctx.appendSystemPrompts) {
    args.push("--append-system-prompt", systemPrompt);
  }
  if (ctx.spawn.tools) {
    const tools = new Set(
      ctx.spawn.tools
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean),
    );
    tools.add("workflow_done");
    args.push("--tools", [...tools].join(","));
  }
  return args;
}

export type StandalonePiArgsOptions = {
  promptFile: string;
  forkSessionFile?: string;
  /** Skip startup network (model catalogs). Useful for stub providers. */
  offline?: boolean;
};

/**
 * Args for a standalone (non-Herdr) child `pi`.
 * Print mode (`-p`) so the process exits after workflow_done terminates the turn.
 */
export function buildStandalonePiArgs(
  ctx: AgentStartContext,
  options: StandalonePiArgsOptions,
): string[] {
  const args = defaultAgentArgs(ctx);
  if (ctx.spawn.fork) {
    if (!options.forkSessionFile) {
      throw new Error(
        "spawn.fork requires a persisted orchestrator session file (do not use --no-session on the parent)",
      );
    }
    const sessionIdx = args.indexOf("--no-session");
    if (sessionIdx !== -1) args.splice(sessionIdx, 1);
    args.push("--fork", options.forkSessionFile);
  }
  args.push("--name", ctx.spawn.name, "-a", "-p", "--no-context-files");
  if (options.offline) args.push("--offline");
  args.push(`@${options.promptFile}`);
  return args;
}

/**
 * Resolve the vanilla `pi` binary to spawn as a child.
 * Prefers `PI_BIN`, then the running pi CLI script, then `pi` on PATH.
 */
export function resolvePiInvocation(extraArgs: string[]): PiInvocation {
  const fromEnv = process.env.PI_BIN?.trim();
  if (fromEnv) {
    return splitCommand(fromEnv, extraArgs);
  }

  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (
    currentScript &&
    !isBunVirtualScript &&
    existsSync(currentScript) &&
    looksLikePiCli(currentScript)
  ) {
    return { command: process.execPath, args: [currentScript, ...extraArgs] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args: extraArgs };
  }

  return { command: "pi", args: extraArgs };
}

function looksLikePiCli(scriptPath: string): boolean {
  const normalized = scriptPath.replaceAll("\\", "/");
  const base = path.basename(normalized);
  return base === "pi" || base === "cli.js" || /\/pi-coding-agent\/dist\/cli\.js$/.test(normalized);
}

function splitCommand(raw: string, extraArgs: string[]): PiInvocation {
  const parts = raw.split(/\s+/).filter(Boolean);
  const command = parts[0];
  if (!command) return { command: "pi", args: extraArgs };
  return { command, args: [...parts.slice(1), ...extraArgs] };
}

/** Best-effort parse of Wiz MCP env for standalone spawn.kind=pi-wiz. */
export function loadWizEnv(homeDir = os.homedir()): Record<string, string> {
  const wizEnv = path.join(homeDir, ".config", "wiz-mcp", "env.zsh");
  if (!existsSync(wizEnv)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(wizEnv, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (!key) continue;
    env[key] = unquoteShell(match[2] ?? "");
  }
  return env;
}

function unquoteShell(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function buildValidationRetryPrompt(
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

export function buildMissingResultRetryPrompt(
  submission: number,
  maxSubmissions: number,
): string {
  return [
    "You settled without calling workflow_done.",
    `Submission ${submission} of ${maxSubmissions}.`,
    "",
    "This step is incomplete until workflow_done accepts structured output.",
    "Call workflow_done now with the best available result.",
    "If evidence is incomplete, still submit: use status=\"inconclusive\" (or ok=false when that is the schema) and list evidenceGaps.",
    "Do not keep investigating past this reminder unless one bounded probe is required to fill a required field.",
  ].join("\n");
}

export function resolveChildExtensionPath(fromUrl = import.meta.url): string {
  return path.resolve(path.dirname(new URL(fromUrl).pathname), "../child/extension.ts");
}
