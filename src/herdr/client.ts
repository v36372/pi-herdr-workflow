import { spawn } from "node:child_process";
import { Effect, Schema } from "effect";

export type HerdrJsonEnvelope = {
  result?: unknown;
  error?: { code?: string; message?: string };
  id?: string;
};

export type HerdrExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type HerdrClientOptions = {
  /** Binary name or path. Defaults to `herdr`. */
  binary?: string;
  /** Injected for tests. Defaults to spawning the binary. */
  exec?: (args: string[], signal?: AbortSignal) => Promise<HerdrExecResult>;
};

/** Machine-readable Herdr CLI/server failure with preserved error code. */
export class HerdrError extends Schema.TaggedErrorClass<HerdrError>()("HerdrError", {
  code: Schema.String,
  message: Schema.String,
  args: Schema.Array(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
  id: Schema.optionalKey(Schema.String),
}) {}

export function isHerdrError(error: unknown): error is HerdrError {
  return (
    error instanceof HerdrError ||
    (typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error as { _tag: unknown })._tag === "HerdrError")
  );
}

export function makeHerdrError(
  code: string,
  message: string,
  options: { args?: readonly string[]; exitCode?: number | null; id?: string } = {},
): HerdrError {
  return new HerdrError({
    code,
    message,
    args: [...(options.args ?? [])],
    exitCode: options.exitCode ?? null,
    ...(options.id !== undefined ? { id: options.id } : {}),
  });
}

/**
 * Thin typed wrapper over the herdr CLI. Uses `--json`-friendly subcommands
 * that print a `{ result | error }` envelope on stdout.
 *
 * Methods are Promise-facing for the current executor/tests. Internals lift
 * process I/O through Effect so callers can later consume the Effect surface.
 */
export class HerdrClient {
  private readonly binary: string;
  private readonly execImpl: (args: string[], signal?: AbortSignal) => Promise<HerdrExecResult>;

  constructor(options: HerdrClientOptions = {}) {
    this.binary = options.binary ?? "herdr";
    this.execImpl = options.exec ?? ((args, signal) => execProcess(this.binary, args, signal));
  }

  /** Effect form of {@link exec}. */
  execEffect(args: string[], signal?: AbortSignal): Effect.Effect<HerdrExecResult, HerdrError> {
    return Effect.tryPromise({
      try: async () => {
        const result = await this.execImpl(args, signal);
        if (signal?.aborted) {
          throw abortError(signal);
        }
        const envelope = findHerdrErrorEnvelope(result);
        if (envelope) {
          throw herdrEnvelopeError(args, envelope, result.code);
        }
        if (result.code !== 0) {
          throw herdrFailure(args, result);
        }
        return result;
      },
      catch: (cause) => {
        if (isHerdrError(cause)) return cause;
        if (cause instanceof Error) {
          return makeHerdrError("command_failed", cause.message, { args });
        }
        return makeHerdrError("command_failed", String(cause), { args });
      },
    });
  }

  async exec(args: string[], signal?: AbortSignal): Promise<HerdrExecResult> {
    return Effect.runPromise(this.execEffect(args, signal));
  }

  /** Effect form of {@link json}. */
  jsonEffect<T = unknown>(args: string[], signal?: AbortSignal): Effect.Effect<T, HerdrError> {
    return this.execEffect(args, signal).pipe(
      Effect.flatMap((result) => {
        const stdout = result.stdout.trim();
        if (!stdout) {
          return Effect.fail(
            makeHerdrError("invalid_response", `Expected JSON from herdr ${args.join(" ")}`, {
              args,
              exitCode: result.code,
            }),
          );
        }
        let value: HerdrJsonEnvelope;
        try {
          value = JSON.parse(stdout) as HerdrJsonEnvelope;
        } catch (cause) {
          return Effect.fail(
            makeHerdrError(
              "invalid_response",
              `Failed to parse JSON from herdr ${args.join(" ")}: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
              { args, exitCode: result.code },
            ),
          );
        }
        if (value.error) {
          return Effect.fail(herdrEnvelopeError(args, value, result.code));
        }
        return Effect.succeed(value as T);
      }),
    );
  }

  async json<T = unknown>(args: string[], signal?: AbortSignal): Promise<T> {
    return Effect.runPromise(this.jsonEffect<T>(args, signal));
  }

  async workspaceCreate(
    options: { cwd?: string; label?: string; focus?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<{ workspace_id: string; pane_id?: string }> {
    const args = ["workspace", "create"];
    if (options.cwd) args.push("--cwd", options.cwd);
    if (options.label) args.push("--label", options.label);
    args.push(options.focus ? "--focus" : "--no-focus");
    const response = await this.json<{
      result: {
        workspace: { workspace_id: string };
        root_pane?: { pane_id: string };
        pane?: { pane_id: string };
      };
    }>(args, signal);
    const paneId =
      response.result.root_pane?.pane_id ?? response.result.pane?.pane_id;
    return {
      workspace_id: response.result.workspace.workspace_id,
      ...(paneId ? { pane_id: paneId } : {}),
    };
  }

  async workspaceClose(workspaceId: string, signal?: AbortSignal): Promise<void> {
    await this.exec(["workspace", "close", workspaceId], signal);
  }

  async workspaceFocus(workspaceId: string, signal?: AbortSignal): Promise<void> {
    await this.exec(["workspace", "focus", workspaceId], signal);
  }

  async tabFocus(tabId: string, signal?: AbortSignal): Promise<void> {
    await this.exec(["tab", "focus", tabId], signal);
  }

  async tabCreate(
    options: {
      workspaceId?: string;
      cwd?: string;
      label?: string;
      focus?: boolean;
    } = {},
    signal?: AbortSignal,
  ): Promise<{ tab_id: string; pane_id?: string; workspace_id?: string }> {
    const args = ["tab", "create"];
    if (options.workspaceId) args.push("--workspace", options.workspaceId);
    if (options.cwd) args.push("--cwd", options.cwd);
    if (options.label) args.push("--label", options.label);
    args.push(options.focus ? "--focus" : "--no-focus");
    const response = await this.json<{
      result: {
        tab: { tab_id: string; workspace_id?: string };
        root_pane?: { pane_id: string };
        pane?: { pane_id: string };
      };
    }>(args, signal);
    const paneId =
      response.result.root_pane?.pane_id ?? response.result.pane?.pane_id;
    return {
      tab_id: response.result.tab.tab_id,
      ...(paneId ? { pane_id: paneId } : {}),
      ...(response.result.tab.workspace_id
        ? { workspace_id: response.result.tab.workspace_id }
        : {}),
    };
  }

  async tabClose(tabId: string, signal?: AbortSignal): Promise<void> {
    await this.exec(["tab", "close", tabId], signal);
  }

  async paneList(workspaceId: string, signal?: AbortSignal): Promise<Array<{ pane_id: string }>> {
    const response = await this.json<{ result: { panes: Array<{ pane_id: string }> } }>(
      ["pane", "list", "--workspace", workspaceId],
      signal,
    );
    return response.result.panes ?? [];
  }

  async paneSplit(
    options: {
      paneId: string;
      direction: "right" | "down";
      cwd?: string;
      focus?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<{ pane_id: string }> {
    const args = [
      "pane",
      "split",
      options.paneId,
      "--direction",
      options.direction,
      options.focus ? "--focus" : "--no-focus",
    ];
    if (options.cwd) args.push("--cwd", options.cwd);
    const response = await this.json<{ result: { pane: { pane_id: string } } }>(args, signal);
    return { pane_id: response.result.pane.pane_id };
  }

  async paneRename(paneId: string, label: string, signal?: AbortSignal): Promise<void> {
    await this.exec(["pane", "rename", paneId, label], signal);
  }

  async paneRun(paneId: string, command: string, signal?: AbortSignal): Promise<void> {
    await this.exec(["pane", "run", paneId, command], signal);
  }

  async paneSendText(paneId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.exec(["pane", "send-text", paneId, text], signal);
  }

  async paneSendKeys(paneId: string, keys: string[], signal?: AbortSignal): Promise<void> {
    await this.exec(["pane", "send-keys", paneId, ...keys], signal);
  }

  async paneClose(paneId: string, signal?: AbortSignal): Promise<void> {
    await this.exec(["pane", "close", paneId], signal);
  }

  async agentStart(
    options: {
      name: string;
      kind: string;
      paneId: string;
      args?: string[];
      timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const args = [
      "agent",
      "start",
      options.name,
      "--kind",
      options.kind,
      "--pane",
      options.paneId,
    ];
    if (options.timeoutMs !== undefined) {
      args.push("--timeout", String(options.timeoutMs));
    }
    if (options.args?.length) args.push("--", ...options.args);
    await this.exec(args, signal);
  }

  async agentGet(
    target: string,
    signal?: AbortSignal,
  ): Promise<{ agent_status: "idle" | "working" | "blocked" | "unknown" | "done" }> {
    const response = await this.json<{
      result: {
        agent: {
          agent_status: "idle" | "working" | "blocked" | "unknown" | "done";
        };
      };
    }>(["agent", "get", target], signal);
    return response.result.agent;
  }

  async agentRead(
    target: string,
    options: { source?: string; lines?: number; raw?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<string> {
    const args = ["agent", "read", target];
    if (options.source) args.push("--source", options.source);
    if (options.lines != null) args.push("--lines", String(options.lines));
    if (options.raw) args.push("--ansi");
    return (await this.exec(args, signal)).stdout;
  }

  async agentSendKeys(target: string, keys: string[], signal?: AbortSignal): Promise<void> {
    await this.exec(["agent", "send-keys", target, ...keys], signal);
  }

  async agentPrompt(
    target: string,
    text: string,
    options: {
      wait?: boolean;
      until?: Array<"idle" | "working" | "blocked" | "unknown" | "done">;
      timeoutMs?: number;
    } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    const args = ["agent", "prompt", target, text];
    if (options.wait) args.push("--wait");
    for (const status of options.until ?? []) args.push("--until", status);
    if (options.timeoutMs !== undefined) {
      args.push("--timeout", String(options.timeoutMs));
    }
    await this.exec(args, signal);
  }

  async agentWait(
    target: string,
    statuses: Array<"idle" | "working" | "blocked" | "unknown" | "done">,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const args = ["agent", "wait", target];
    for (const status of statuses) args.push("--until", status);
    args.push("--timeout", String(timeoutMs));
    await this.exec(args, signal);
  }

  async waitAgent(
    target: string,
    statuses: Array<"idle" | "working" | "blocked" | "unknown" | "done">,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.agentWait(target, statuses, timeoutMs, signal);
  }

  async waitOutput(
    paneId: string,
    match: string,
    options: { regex?: boolean; timeoutMs?: number; source?: string } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    const args = [
      "pane",
      "wait-output",
      paneId,
      options.regex ? "--regex" : "--match",
      match,
    ];
    if (options.timeoutMs !== undefined) args.push("--timeout", String(options.timeoutMs));
    if (options.source) args.push("--source", options.source);
    await this.exec(args, signal);
  }
}

/** Return a parseable Herdr error envelope from stdout/stderr, if present. */
function findHerdrErrorEnvelope(result: HerdrExecResult): HerdrJsonEnvelope | null {
  for (const raw of [result.stderr, result.stdout]) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as HerdrJsonEnvelope;
      if (value && typeof value === "object" && value.error) {
        return value;
      }
    } catch {
      // Not JSON — leave for callers that treat non-zero exits as plain text.
    }
  }
  return null;
}

function herdrFailure(args: string[], result: HerdrExecResult): HerdrError {
  for (const raw of [result.stderr, result.stdout]) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    return makeHerdrError("command_failed", trimmed, {
      args,
      exitCode: result.code,
    });
  }
  return makeHerdrError(
    "command_failed",
    `herdr ${args.join(" ")} failed (${result.code})`,
    { args, exitCode: result.code },
  );
}

function herdrEnvelopeError(
  args: string[],
  value: HerdrJsonEnvelope,
  exitCode: number | null,
): HerdrError {
  const code = value.error?.code?.trim() || "command_failed";
  const message =
    value.error?.message?.trim() ||
    value.error?.code?.trim() ||
    `herdr ${args.join(" ")} failed`;
  return makeHerdrError(code, message, {
    args,
    exitCode,
    ...(value.id ? { id: value.id } : {}),
  });
}

function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error("Aborted");
}

function execProcess(
  binary: string,
  args: string[],
  signal?: AbortSignal,
): Promise<HerdrExecResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const onAbort = () => {
      child.kill("SIGTERM");
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr });
    });
  });
}
