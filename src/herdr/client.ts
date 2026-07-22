import { spawn } from "node:child_process";

export type HerdrJsonEnvelope = {
  result?: unknown;
  error?: { code?: string; message?: string };
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

/**
 * Thin typed wrapper over the herdr CLI. Uses `--json`-friendly subcommands
 * that print a `{ result | error }` envelope on stdout.
 */
export class HerdrClient {
  private readonly binary: string;
  private readonly execImpl: (args: string[], signal?: AbortSignal) => Promise<HerdrExecResult>;

  constructor(options: HerdrClientOptions = {}) {
    this.binary = options.binary ?? "herdr";
    this.execImpl = options.exec ?? ((args, signal) => execProcess(this.binary, args, signal));
  }

  async exec(args: string[], signal?: AbortSignal): Promise<HerdrExecResult> {
    const result = await this.execImpl(args, signal);
    if (signal?.aborted) {
      throw abortError(signal);
    }
    if (result.code !== 0) {
      throw new Error(parseHerdrError(result) || `herdr ${args.join(" ")} failed (${result.code})`);
    }
    return result;
  }

  async json<T = unknown>(args: string[], signal?: AbortSignal): Promise<T> {
    const result = await this.exec(args, signal);
    const stdout = result.stdout.trim();
    if (!stdout) {
      throw new Error(`Expected JSON from herdr ${args.join(" ")}`);
    }
    let value: HerdrJsonEnvelope;
    try {
      value = JSON.parse(stdout) as HerdrJsonEnvelope;
    } catch {
      throw new Error(`Failed to parse JSON from herdr ${args.join(" ")}`);
    }
    if (value.error) {
      throw new Error(value.error.message || value.error.code || `herdr ${args.join(" ")} failed`);
    }
    return value as T;
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

  async paneClose(paneId: string, signal?: AbortSignal): Promise<void> {
    await this.exec(["pane", "close", paneId], signal);
  }

  /**
   * Block until herdr reports the pane/agent at `status`.
   * Same primitive the `herdr` tool's `wait_agent` action uses
   * (`herdr wait agent-status`).
   */
  async agentWait(
    target: string,
    status: "idle" | "working" | "blocked" | "unknown" | "done",
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.exec(
      [
        "wait",
        "agent-status",
        target,
        "--status",
        status,
        "--timeout",
        String(timeoutMs),
      ],
      signal,
    );
  }

  /**
   * wait_agent-style: accept any of several terminal statuses.
   * Mirrors pi-herdr tool `wait_agent` with statuses=[idle,done].
   */
  async waitAgent(
    target: string,
    statuses: Array<"idle" | "working" | "blocked" | "unknown" | "done">,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (statuses.length === 0) {
      throw new Error("waitAgent requires at least one status");
    }
    if (statuses.length === 1) {
      await this.agentWait(target, statuses[0]!, timeoutMs, signal);
      return;
    }
    // herdr CLI takes one --status; race one waiter per accepted status.
    const deadline = Date.now() + timeoutMs;
    const errors: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const controllers = statuses.map(() => new AbortController());
      const onParentAbort = () => {
        for (const c of controllers) c.abort(signal?.reason);
      };
      signal?.addEventListener("abort", onParentAbort, { once: true });

      const finishOk = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onParentAbort);
        for (const c of controllers) c.abort();
        resolve();
      };
      const finishErr = (error: unknown) => {
        errors.push(error);
        if (errors.length < statuses.length) return;
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onParentAbort);
        reject(
          signal?.aborted
            ? abortError(signal)
            : new Error(
                `Timed out waiting for ${target} to reach one of [${statuses.join(", ")}]`,
              ),
        );
      };

      for (let i = 0; i < statuses.length; i++) {
        const status = statuses[i]!;
        const remaining = Math.max(1, deadline - Date.now());
        this.agentWait(target, status, remaining, controllers[i]!.signal).then(
          finishOk,
          finishErr,
        );
      }
    });
  }

  async waitOutput(
    paneId: string,
    match: string,
    options: { regex?: boolean; timeoutMs?: number; source?: string } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    const args = ["wait", "output", paneId, "--match", match];
    if (options.regex) args.push("--regex");
    if (options.timeoutMs !== undefined) args.push("--timeout", String(options.timeoutMs));
    if (options.source) args.push("--source", options.source);
    await this.exec(args, signal);
  }
}

function parseHerdrError(result: HerdrExecResult): string | null {
  for (const raw of [result.stderr, result.stdout]) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as HerdrJsonEnvelope;
      if (value.error?.message || value.error?.code) {
        return value.error.message || value.error.code || null;
      }
    } catch {
      return trimmed;
    }
  }
  return null;
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
