import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Result-file protocol (interactive-subagents-style sidecars).
 *
 * Per agent attempt, under `runDir/agents/<nodeId>/<attemptId>/`:
 * - `result.json`  — structured output written by `workflow_done`
 * - `session.exit` — exit sidecar `{ type: "done" | "error" | "rejected", ... }`
 * - `task.md`      — full prompt delivered to the child
 * - `session.jsonl`— optional child session path (when known)
 *
 * Engine owns routing/validation. Herdr only delivers prompts into panes and
 * the orchestrator polls these files for completion.
 */

export type ExitSidecar =
  | { type: "done" }
  | { type: "error"; errorMessage: string }
  | { type: "rejected"; error: string };

export type ResultFilePayload = {
  schema: "pi-herdr-workflows.result.v1";
  runId: string;
  nodeId: string;
  attemptId: string;
  output: unknown;
  writtenAt: string;
};

export function ensureArtifactDir(artifactDir: string): void {
  mkdirSync(artifactDir, { recursive: true });
}

export function writeTaskFile(artifactDir: string, prompt: string): string {
  ensureArtifactDir(artifactDir);
  const taskPath = path.join(artifactDir, "task.md");
  writeFileSync(taskPath, prompt, "utf8");
  return taskPath;
}

export function writeResultFile(
  resultPath: string,
  payload: Omit<ResultFilePayload, "schema" | "writtenAt">,
): void {
  mkdirSync(path.dirname(resultPath), { recursive: true });
  const body: ResultFilePayload = {
    schema: "pi-herdr-workflows.result.v1",
    writtenAt: new Date().toISOString(),
    ...payload,
  };
  writeFileSync(resultPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

export function writeExitSidecar(exitPath: string, sidecar: ExitSidecar): void {
  mkdirSync(path.dirname(exitPath), { recursive: true });
  writeFileSync(exitPath, `${JSON.stringify(sidecar)}\n`, "utf8");
}

export function readExitSidecar(exitPath: string): ExitSidecar | null {
  if (!existsSync(exitPath)) return null;
  try {
    return JSON.parse(readFileSync(exitPath, "utf8")) as ExitSidecar;
  } catch {
    return null;
  }
}

export function readResultFile(resultPath: string): ResultFilePayload | null {
  if (!existsSync(resultPath)) return null;
  try {
    return JSON.parse(readFileSync(resultPath, "utf8")) as ResultFilePayload;
  } catch {
    return null;
  }
}

export async function pollUntil(
  check: () => boolean | Promise<boolean>,
  options: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? 250;
  const signal = options.signal;
  for (;;) {
    if (signal?.aborted) {
      const reason: unknown = signal.reason;
      throw reason instanceof Error ? reason : new Error("Aborted");
    }
    if (await check()) return;
    await sleep(intervalMs, signal);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
