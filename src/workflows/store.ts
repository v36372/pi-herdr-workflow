import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Context, Effect, FileSystem, Layer } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { NodeFileSystem } from "@effect/platform-node";
import type {
  WorkflowDefinition,
  WorkflowDefinitionSnapshot,
  WorkflowNodeDefinition,
  WorkflowNodeSnapshot,
  WorkflowRunManifest,
  WorkflowRunState,
  WorkflowTraceEvent,
  WorkflowTraceEventDraft,
} from "./types.js";

export const RUN_BUNDLE_SCHEMA = "pi-herdr-workflows.run-bundle.v1" as const;
export const TRACE_EVENT_SCHEMA = "pi-herdr-workflows.trace-event.v1" as const;
export const DEFINITION_SNAPSHOT_SCHEMA = "pi-herdr-workflows.definition-snapshot.v1" as const;

const MANIFEST_PATH = "manifest.json";
const WORKFLOW_SNAPSHOT_PATH = "workflow.json";
const STATE_PATH = "state.json";
const TRACE_PATH = "trace.ndjson";

/** Runs directory: `$PI_WORKFLOWS_RUNS_DIR` or `~/.pi/agent/workflows/runs`. */
export function workflowRunsBaseDir(homeDir: string = os.homedir()): string {
  const override = process.env.PI_WORKFLOWS_RUNS_DIR;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return path.join(homeDir, ".pi", "agent", "workflows", "runs");
}

export function createRunId(workflowName: string, now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const slug = workflowName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-|-$)/g, "")
    .slice(0, 40);
  return `${stamp}-${slug || "workflow"}-${randomUUID().slice(0, 8)}`;
}

export type LoadedRunBundle = {
  runDir: string;
  manifest: WorkflowRunManifest;
  state: WorkflowRunState;
  snapshot: WorkflowDefinitionSnapshot | null;
};

export interface Interface {
  readonly outputRoot: string;
  readonly runDirFor: (runId: string) => string;
  readonly initializeRunBundle: (
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
  ) => Effect.Effect<string, PlatformError>;
  readonly writeSnapshot: (
    runDir: string,
    state: WorkflowRunState,
    event: WorkflowTraceEventDraft,
  ) => Effect.Effect<WorkflowTraceEvent, PlatformError>;
  readonly appendTrace: (
    runDir: string,
    state: WorkflowRunState,
    event: WorkflowTraceEventDraft,
  ) => Effect.Effect<WorkflowTraceEvent, PlatformError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@pi-herdr-workflows/WorkflowRunStore",
) {}

/**
 * Persists run bundles. A bundle directory contains `manifest.json`,
 * `workflow.json` (definition snapshot), `state.json` (full run projection,
 * atomically replaced), and `trace.ndjson` (append-only event log).
 */
export const make = (outputRoot: string = workflowRunsBaseDir()) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const traceSeqByRun = new Map<string, number>();
    // Serialize appends per path so concurrent snapshot writes cannot interleave
    // ndjson lines. Ceiling: one chain per path for the life of the store.
    const appendChainByPath = new Map<string, Promise<void>>();

    const runDirFor = (runId: string): string => path.join(outputRoot, runId);

    const nextTraceSeq = (runDir: string): number => {
      const next = (traceSeqByRun.get(runDir) ?? 0) + 1;
      traceSeqByRun.set(runDir, next);
      return next;
    };

    const appendJsonLine = (
      filePath: string,
      value: unknown,
    ): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        const chunk = value === null ? "" : `${JSON.stringify(value)}\n`;
        // Chain through a mutable promise map so concurrent Effect fibers still
        // append in order for a given path.
        yield* Effect.promise(() => {
          const prior = appendChainByPath.get(filePath) ?? Promise.resolve();
          const nextWrite = prior.then(() =>
            Effect.runPromise(fs.writeFileString(filePath, chunk, { flag: "a" })),
          );
          const tracked = nextWrite.finally(() => {
            if (appendChainByPath.get(filePath) === tracked) {
              appendChainByPath.delete(filePath);
            }
          });
          appendChainByPath.set(filePath, tracked);
          return tracked;
        });
      });

    const writeJsonAtomic = (
      filePath: string,
      value: unknown,
    ): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* () {
        const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(tempPath, `${JSON.stringify(value, null, 2)}\n`);
        yield* fs.rename(tempPath, filePath);
      });

    const appendTrace = Effect.fn("WorkflowRunStore.appendTrace")(function* (
      runDir: string,
      state: WorkflowRunState,
      event: WorkflowTraceEventDraft,
    ) {
      const traceEvent: WorkflowTraceEvent = {
        seq: nextTraceSeq(runDir),
        at: new Date().toISOString(),
        runId: state.runId,
        ...event,
      };
      yield* appendJsonLine(path.join(runDir, TRACE_PATH), traceEvent);
      return traceEvent;
    });

    const writeSnapshot = Effect.fn("WorkflowRunStore.writeSnapshot")(function* (
      runDir: string,
      state: WorkflowRunState,
      event: WorkflowTraceEventDraft,
    ) {
      state.updatedAt = new Date().toISOString();
      yield* writeJsonAtomic(path.join(runDir, STATE_PATH), state);
      yield* writeJsonAtomic(path.join(runDir, MANIFEST_PATH), createManifest(state));
      return yield* appendTrace(runDir, state, event);
    });

    const initializeRunBundle = Effect.fn("WorkflowRunStore.initializeRunBundle")(
      function* (workflow: WorkflowDefinition, state: WorkflowRunState) {
        const runDir = runDirFor(state.runId);
        yield* fs.makeDirectory(runDir, { recursive: true });
        traceSeqByRun.set(runDir, 0);

        yield* writeJsonAtomic(
          path.join(runDir, WORKFLOW_SNAPSHOT_PATH),
          createDefinitionSnapshot(workflow),
        );
        yield* writeJsonAtomic(path.join(runDir, MANIFEST_PATH), createManifest(state));
        yield* writeJsonAtomic(path.join(runDir, STATE_PATH), state);
        yield* appendJsonLine(path.join(runDir, TRACE_PATH), null);

        return runDir;
      },
    );

    return Service.of({
      outputRoot,
      runDirFor,
      initializeRunBundle,
      writeSnapshot,
      appendTrace,
    });
  });

export const layer = (outputRoot?: string) =>
  Layer.effect(Service, make(outputRoot)).pipe(Layer.provide(NodeFileSystem.layer));

/**
 * Promise-facing store used by the engine facade. Methods run the Effect store
 * against the Node filesystem layer.
 */
export class WorkflowRunStore {
  readonly outputRoot: string;
  private readonly service: Interface;

  constructor(outputRoot: string = workflowRunsBaseDir()) {
    this.outputRoot = outputRoot;
    this.service = Effect.runSync(make(outputRoot).pipe(Effect.provide(NodeFileSystem.layer)));
  }

  runDirFor(runId: string): string {
    return this.service.runDirFor(runId);
  }

  initializeRunBundle(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
  ): Promise<string> {
    return Effect.runPromise(this.service.initializeRunBundle(workflow, state));
  }

  writeSnapshot(
    runDir: string,
    state: WorkflowRunState,
    event: WorkflowTraceEventDraft,
  ): Promise<WorkflowTraceEvent> {
    return Effect.runPromise(this.service.writeSnapshot(runDir, state, event));
  }

  appendTrace(
    runDir: string,
    state: WorkflowRunState,
    event: WorkflowTraceEventDraft,
  ): Promise<WorkflowTraceEvent> {
    return Effect.runPromise(this.service.appendTrace(runDir, state, event));
  }
}

/** Read a run bundle from disk. Returns null when the bundle is unreadable. */
export async function readRunBundle(runDir: string): Promise<LoadedRunBundle | null> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const manifest = yield* readJsonFile<WorkflowRunManifest>(
        fs,
        path.join(runDir, MANIFEST_PATH),
      );
      const state = yield* readJsonFile<WorkflowRunState>(fs, path.join(runDir, STATE_PATH));
      if (!manifest || !state || manifest.schema !== RUN_BUNDLE_SCHEMA) {
        return null;
      }
      const snapshot = yield* readJsonFile<WorkflowDefinitionSnapshot>(
        fs,
        path.join(runDir, WORKFLOW_SNAPSHOT_PATH),
      );
      return { runDir, manifest, state, snapshot };
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
}

/** List run bundles under `outputRoot`, most recently started first. */
export async function listRunBundles(outputRoot: string): Promise<LoadedRunBundle[]> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const entries = yield* fs
        .readDirectory(outputRoot)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])));
      const bundles: LoadedRunBundle[] = [];
      for (const entry of entries) {
        const bundle = yield* Effect.promise(() =>
          readRunBundle(path.join(outputRoot, entry)),
        );
        if (bundle) {
          bundles.push(bundle);
        }
      }
      bundles.sort((a, b) => b.state.startedAt.localeCompare(a.state.startedAt));
      return bundles;
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
}

export function createDefinitionSnapshot(workflow: WorkflowDefinition): WorkflowDefinitionSnapshot {
  return {
    schema: DEFINITION_SNAPSHOT_SCHEMA,
    name: workflow.name,
    startAt: workflow.startAt,
    nodes: Object.fromEntries(
      Object.entries(workflow.nodes).map(([nodeId, node]) => [nodeId, snapshotNode(node)]),
    ),
    edges: structuredClone(workflow.edges),
  };
}

function createManifest(state: WorkflowRunState): WorkflowRunManifest {
  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: state.runId,
    workflowName: state.workflowName,
    ...(state.runTitle !== undefined ? { runTitle: state.runTitle } : {}),
    ...(state.workflowPath !== undefined ? { workflowPath: state.workflowPath } : {}),
    startedAt: state.startedAt,
    ...(state.finishedAt !== undefined ? { finishedAt: state.finishedAt } : {}),
    status: state.status,
    traceSchema: TRACE_EVENT_SCHEMA,
    paths: {
      workflow: WORKFLOW_SNAPSHOT_PATH,
      state: STATE_PATH,
      trace: TRACE_PATH,
    },
  };
}

function snapshotNode(node: WorkflowNodeDefinition): WorkflowNodeSnapshot {
  const common: WorkflowNodeSnapshot = {
    nodeType: node.nodeType,
    ...(node.timeoutMs !== undefined ? { timeoutMs: node.timeoutMs } : {}),
    ...(node.statusDetail !== undefined ? { statusDetail: node.statusDetail } : {}),
  };
  if (node.nodeType === "agent") {
    if (node.expectedOutput !== undefined) {
      common.expectedOutput = node.expectedOutput;
    }
    if (node.spawn !== undefined) {
      const spawn = node.spawn;
      common.spawn = {
        ...(typeof spawn.name === "string" ? { name: spawn.name } : {}),
        ...(spawn.agent !== undefined ? { agent: spawn.agent } : {}),
        ...(spawn.model !== undefined ? { model: spawn.model } : {}),
        ...(spawn.skills !== undefined ? { skills: spawn.skills } : {}),
        ...(spawn.tools !== undefined ? { tools: spawn.tools } : {}),
        ...(typeof spawn.cwd === "string" ? { cwd: spawn.cwd } : {}),
        ...(spawn.fork !== undefined ? { fork: spawn.fork } : {}),
        ...(spawn.interactive !== undefined ? { interactive: spawn.interactive } : {}),
      };
    }
  }
  if (node.nodeType === "checkpoint" && node.summary !== undefined) {
    common.summary = node.summary;
  }
  if (node.nodeType === "action") {
    common.actionExecution = "exec" in node ? "shell" : "function";
  }
  return common;
}

function readJsonFile<T>(
  fs: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<T | null> {
  return Effect.gen(function* () {
    const raw = yield* fs.readFileString(filePath);
    return JSON.parse(raw) as T;
  }).pipe(Effect.catch(() => Effect.succeed(null)));
}
