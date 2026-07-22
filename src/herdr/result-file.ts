import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Result-file protocol for workflow agent attempts.
 *
 * Per agent attempt, under `runDir/agents/<nodeId>/<attemptId>/`:
 * - `result.json`  — structured output written by `workflow_done`
 * - `task.md`      — full prompt delivered to the child
 * - `agent-env.sh` — environment sourced into the pane shell before agent start
 *
 * Engine owns routing/validation. Herdr delivers prompts into panes and waits
 * on agent lifecycle signals; `result.json` is the authoritative payload.
 */

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

export function readResultFile(resultPath: string): ResultFilePayload | null {
  if (!existsSync(resultPath)) return null;
  try {
    return JSON.parse(readFileSync(resultPath, "utf8")) as ResultFilePayload;
  } catch {
    return null;
  }
}

/** Drop a rejected result so a later wait cannot accept the stale payload. */
export function clearResultFile(resultPath: string): void {
  if (!existsSync(resultPath)) return;
  unlinkSync(resultPath);
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
