import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Effect, FileSystem } from "effect";

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
 *
 * Sync helpers use node:fs (Node FileSystem is async and cannot run under
 * Effect.runSync). Effect helpers use `effect/FileSystem` for Effect programs.
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

export const ensureArtifactDirEffect = (
  artifactDir: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeDirectory(artifactDir, { recursive: true })),
    Effect.asVoid,
    Effect.orDie,
  );

export function writeTaskFile(artifactDir: string, prompt: string): string {
  ensureArtifactDir(artifactDir);
  const taskPath = path.join(artifactDir, "task.md");
  writeFileSync(taskPath, prompt, "utf8");
  return taskPath;
}

export const writeTaskFileEffect = (
  artifactDir: string,
  prompt: string,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(artifactDir, { recursive: true });
    const taskPath = path.join(artifactDir, "task.md");
    yield* fs.writeFileString(taskPath, prompt);
    return taskPath;
  }).pipe(Effect.orDie);

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

export const writeResultFileEffect = (
  resultPath: string,
  payload: Omit<ResultFilePayload, "schema" | "writtenAt">,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(path.dirname(resultPath), { recursive: true });
    const body: ResultFilePayload = {
      schema: "pi-herdr-workflows.result.v1",
      writtenAt: new Date().toISOString(),
      ...payload,
    };
    yield* fs.writeFileString(resultPath, `${JSON.stringify(body, null, 2)}\n`);
  }).pipe(Effect.orDie);

export function readResultFile(resultPath: string): ResultFilePayload | null {
  if (!existsSync(resultPath)) return null;
  try {
    return JSON.parse(readFileSync(resultPath, "utf8")) as ResultFilePayload;
  } catch {
    return null;
  }
}

export const readResultFileEffect = (
  resultPath: string,
): Effect.Effect<ResultFilePayload | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(resultPath);
    if (!exists) return null;
    const raw = yield* fs.readFileString(resultPath);
    return JSON.parse(raw) as ResultFilePayload;
  }).pipe(Effect.catch(() => Effect.succeed(null)));

/** Drop a rejected result so a later wait cannot accept the stale payload. */
export function clearResultFile(resultPath: string): void {
  if (!existsSync(resultPath)) return;
  unlinkSync(resultPath);
}

export const clearResultFileEffect = (
  resultPath: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(resultPath);
    if (!exists) return;
    yield* fs.remove(resultPath);
  }).pipe(Effect.orDie);

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
