import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import {
  WorkflowEngine,
  agent,
  cancelledError,
  compute,
  defineWorkflow,
  isCancelledError,
  isTimeoutError,
  timeoutError,
  type AgentStepExecutor,
  type AgentStepRequest,
  type AgentStepSubmission,
} from "../src/index.ts";
import { writeFakeAgentResult } from "../src/herdr/executor.ts";
import {
  Service as WorkflowRunStoreService,
  createRunId,
  layer as storeLayer,
} from "../src/workflows/store.ts";
import { HerdrClient, isHerdrError, makeHerdrError } from "../src/herdr/client.ts";

class FileBackedExecutor implements AgentStepExecutor {
  async runAgentStep(
    request: AgentStepRequest,
    _signal: AbortSignal,
  ): Promise<AgentStepSubmission> {
    writeFakeAgentResult({
      resultPath: request.contract.resultPath,
      runId: request.contract.runId,
      nodeId: request.contract.nodeId,
      attemptId: request.contract.attemptId,
      output: { reply: "effect" },
    });
    const result = JSON.parse(readFileSync(request.contract.resultPath, "utf8"));
    const accepted = await request.accept(result.output);
    if (!accepted.ok) throw new Error(accepted.error);
    return { output: accepted.value };
  }
}

test("tagged workflow errors carry stable tags and messages", () => {
  const timeout = timeoutError(1500);
  assert.equal(timeout._tag, "TimeoutError");
  assert.equal(timeout.timeoutMs, 1500);
  assert.match(timeout.message, /1500/);
  assert.equal(isTimeoutError(timeout), true);

  const cancelled = cancelledError("stop");
  assert.equal(cancelled._tag, "CancelledError");
  assert.equal(cancelled.message, "stop");
  assert.equal(isCancelledError(cancelled), true);
});

test("HerdrError is a tagged schema error", () => {
  const error = makeHerdrError("agent_not_running", "gone", {
    args: ["agent", "get", "x"],
    exitCode: 1,
    id: "cli:test",
  });
  assert.equal(isHerdrError(error), true);
  assert.equal(error._tag, "HerdrError");
  assert.equal(error.code, "agent_not_running");
  assert.equal(error.id, "cli:test");
});

test("WorkflowRunStore Effect layer writes atomic state.json", async () => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "phw-effect-store-"));
  try {
    const program = Effect.gen(function* () {
      const store = yield* WorkflowRunStoreService;
      const runId = createRunId("effect-store");
      const state = {
        runId,
        workflowName: "effect-store",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "running" as const,
        input: { ok: true },
        outputs: {},
        results: {},
        steps: [],
      };
      const workflow = defineWorkflow({
        name: "effect-store",
        startAt: "noop",
        nodes: {
          noop: compute({ run: () => ({ done: true }) }),
        },
        edges: [],
      });
      const runDir = yield* store.initializeRunBundle(workflow, state);
      yield* store.writeSnapshot(runDir, state, {
        scope: "run",
        type: "run_started",
        payload: { workflowName: workflow.name },
      });
      return runDir;
    }).pipe(Effect.provide(storeLayer(outputRoot)));

    const runDir = await Effect.runPromise(program);
    const snapshot = JSON.parse(
      readFileSync(path.join(runDir, "state.json"), "utf8"),
    ) as { runId: string; status: string };
    assert.equal(typeof snapshot.runId, "string");
    assert.equal(snapshot.status, "running");
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("WorkflowEngine.runEffect completes a compute-only graph", async () => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "phw-effect-engine-"));
  const engine = new WorkflowEngine({
    executor: new FileBackedExecutor(),
    outputRoot,
    maxSteps: 10,
  });
  const workflow = defineWorkflow({
    name: "effect-engine",
    startAt: "a",
    nodes: {
      a: compute({ run: ({ input }) => ({ n: (input as { n: number }).n + 1 }) }),
      b: agent({
        spawn: { name: "effect-agent" },
        prompt: () => "hi",
      }),
    },
    edges: [{ from: "a", to: "b" }],
  });

  try {
    const { state } = await Effect.runPromise(engine.runEffect(workflow, { n: 1 }));
    assert.equal(state.status, "completed");
    assert.deepEqual(state.outputs.a, { n: 2 });
    assert.deepEqual(state.finalOutput, { reply: "effect" });
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("HerdrClient.jsonEffect decodes success envelopes", async () => {
  const client = new HerdrClient({
    exec: async () => ({
      code: 0,
      stdout: JSON.stringify({ result: { ok: true } }),
      stderr: "",
    }),
  });
  const value = await Effect.runPromise(
    client.jsonEffect<{ result: { ok: boolean } }>(["agent", "get", "x"]),
  );
  assert.equal(value.result.ok, true);
});
