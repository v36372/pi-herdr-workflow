import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ClaimLostError,
  TimeoutError,
  WorkflowEngine,
  WorkflowSourceChangedError,
  agent,
  checkpoint,
  compute,
  defineWorkflow,
  hashWorkflowSource,
  readRunBundle,
  validateWorkflowDefinition,
  type AgentStepExecutor,
  type AgentStepRequest,
  type AgentStepSubmission,
} from "../src/index.ts";
import { writeFakeAgentResult } from "../src/herdr/executor.ts";
import { HerdrClient, type HerdrExecResult } from "../src/herdr/client.ts";
import { HerdrStepExecutor } from "../src/herdr/executor.ts";

class FileBackedExecutor implements AgentStepExecutor {
  requests: AgentStepRequest[] = [];
  hangUntilAbort = false;

  async runAgentStep(
    request: AgentStepRequest,
    signal: AbortSignal,
  ): Promise<AgentStepSubmission> {
    this.requests.push(request);
    if (this.hangUntilAbort) {
      await new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    writeFakeAgentResult({
      resultPath: request.contract.resultPath,
      runId: request.contract.runId,
      nodeId: request.contract.nodeId,
      attemptId: request.contract.attemptId,
      output: { ok: true, nodeId: request.contract.nodeId },
    });
    const result = JSON.parse(readFileSync(request.contract.resultPath, "utf8"));
    const accepted = await request.accept(result.output);
    if (!accepted.ok) throw new Error(accepted.error);
    return { output: accepted.value };
  }
}

test("park leaves a running bundle that resumeRun finishes", async () => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "phw-park-"));
  const executor = new FileBackedExecutor();
  executor.hangUntilAbort = true;
  const engine = new WorkflowEngine({ executor, outputRoot, maxSteps: 10 });
  const workflow = defineWorkflow({
    name: "park-resume",
    startAt: "work",
    nodes: {
      work: agent({
        spawn: { name: "worker" },
        prompt: () => "work",
      }),
      done: compute({ run: ({ outputs }) => ({ final: outputs.work }) }),
    },
    edges: [{ from: "work", to: "done" }],
  });

  try {
    const runPromise = engine.run(workflow, {}, { runId: "park-resume-1", workflowHash: "abc" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    engine.park();
    const parked = await runPromise;
    assert.equal(parked.state.status, "running");
    assert.equal(parked.state.currentNode, "work");
    assert.equal(parked.state.workflowHash, "abc");

    const resumeEngine = new WorkflowEngine({
      executor: new FileBackedExecutor(),
      outputRoot,
      maxSteps: 10,
    });
    const resumed = await resumeEngine.resumeRun(workflow, "park-resume-1", {
      workflowHash: "abc",
    });
    assert.equal(resumed.state.status, "completed");
    assert.deepEqual(resumed.state.finalOutput, {
      final: { ok: true, nodeId: "work" },
    });
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("resumeRun refuses a workflow source hash mismatch unless forced", async () => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "phw-hash-"));
  const executor = new FileBackedExecutor();
  executor.hangUntilAbort = true;
  const engine = new WorkflowEngine({ executor, outputRoot, maxSteps: 10 });
  const workflow = defineWorkflow({
    name: "hash-check",
    startAt: "work",
    nodes: {
      work: agent({ spawn: { name: "w" }, prompt: () => "x" }),
    },
  });
  try {
    const runPromise = engine.run(workflow, {}, { runId: "hash-1", workflowHash: "old" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    engine.park();
    await runPromise;

    const resumeEngine = new WorkflowEngine({
      executor: new FileBackedExecutor(),
      outputRoot,
      maxSteps: 10,
    });
    await assert.rejects(
      () => resumeEngine.resumeRun(workflow, "hash-1", { workflowHash: "new" }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowSourceChangedError);
        assert.equal(error.runId, "hash-1");
        return true;
      },
    );
    const forced = await resumeEngine.resumeRun(workflow, "hash-1", {
      workflowHash: "new",
      force: true,
    });
    assert.equal(forced.state.status, "completed");
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("continueRun carries checkpoint outputs across the outgoing edge", async () => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "phw-continue-"));
  const executor = new FileBackedExecutor();
  const engine = new WorkflowEngine({ executor, outputRoot, maxSteps: 10 });
  const workflow = defineWorkflow({
    name: "continue-check",
    startAt: "gate",
    nodes: {
      gate: checkpoint({ summary: "need review" }),
      after: compute({
        run: ({ outputs, input }) => ({
          fromGate: outputs.gate,
          answer: input,
        }),
      }),
    },
    edges: [{ from: "gate", to: "after" }],
  });

  try {
    validateWorkflowDefinition(workflow);
    const waiting = await engine.run(workflow, { seed: 1 }, { runId: "parent-1" });
    assert.equal(waiting.state.status, "waiting");
    assert.equal(waiting.state.waitingOn, "gate");

    const continued = await engine.continueRun(workflow, "parent-1", { decision: "ship" });
    assert.equal(continued.state.status, "completed");
    assert.equal(continued.state.parentRunId, "parent-1");
    assert.equal(continued.state.carriedStepCount, 1);
    assert.deepEqual(continued.state.finalOutput, {
      fromGate: { summary: "need review" },
      answer: { decision: "ship" },
    });
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("dynamic timeoutMs aborts a hanging agent node", async () => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "phw-timeout-"));
  const executor = new FileBackedExecutor();
  executor.hangUntilAbort = true;
  const engine = new WorkflowEngine({ executor, outputRoot, maxSteps: 10 });
  const workflow = defineWorkflow({
    name: "timeout-agent",
    startAt: "slow",
    nodes: {
      slow: agent({
        timeoutMs: () => 30,
        spawn: { name: "slow" },
        prompt: () => "hang",
      }),
    },
  });
  try {
    const { state } = await engine.run(workflow, {});
    assert.equal(state.status, "timed_out");
    assert.match(state.error ?? "", /Timed out after 30ms/);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("fence provider turns later writes into ClaimLostError", async () => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "phw-fence-"));
  let lost = false;
  const { WorkflowRunStore } = await import("../src/workflows/store.ts");
  const store = new WorkflowRunStore(outputRoot, {
    fenceProvider: () => () => {
      if (lost) throw new ClaimLostError("fenced-1");
    },
  });
  const executor = new FileBackedExecutor();
  const engine = new WorkflowEngine({ executor, store, maxSteps: 10 });
  const workflow = defineWorkflow({
    name: "fence",
    startAt: "a",
    nodes: { a: compute({ run: () => ({ ok: true }) }) },
  });
  try {
    const { runDir, state } = await engine.run(workflow, {}, { runId: "fenced-1" });
    assert.equal(state.status, "completed");
    lost = true;
    await assert.rejects(
      () =>
        store.writeSnapshot(runDir, state, {
          scope: "run",
          type: "run_resumed",
          payload: {},
        }),
      (error: unknown) => error instanceof ClaimLostError,
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("hashWorkflowSource is stable for identical files", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "phw-hashfile-"));
  const file = path.join(dir, "demo.workflow.ts");
  writeFileSync(file, "export default { name: 'demo' }\n");
  try {
    const first = await hashWorkflowSource(file);
    const second = await hashWorkflowSource(file);
    assert.equal(first, second);
    assert.match(first, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Herdr executor sends Escape when the engine aborts a live agent", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-abort-"));
  const artifactDir = path.join(root, "agents", "review", "12345678-abcd");
  const resultPath = path.join(artifactDir, "result.json");
  const calls: string[][] = [];
  let releasePrompt: (() => void) | undefined;
  const promptGate = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });

  const client = new HerdrClient({
    exec: async (args, signal) => {
      calls.push(args);
      if (args[0] === "workspace" && args[1] === "create") {
        return okJson({
          workspace: { workspace_id: "w1" },
          root_pane: { pane_id: "w1:p1" },
        });
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort, { once: true });
          void promptGate.then(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          });
        });
      }
      if (args[0] === "pane" && args[1] === "wait-output") {
        return okJson();
      }
      return okJson();
    },
  });

  const executor = new HerdrStepExecutor({
    originFocus: {},
    client,
    cwd: root,
  });
  const abort = new AbortController();

  try {
    const step = executor.runAgentStep(
      {
        contract: {
          runId: "run-1",
          workflowName: "review-flow",
          nodeId: "review",
          attemptId: "12345678-abcd",
          artifactDir,
          resultPath,
        },
        prompt: "do work",
        spawn: { name: "Scout: Auth", tools: "read", fork: false },
        accept: async (output) => ({ ok: true as const, value: output }),
      },
      abort.signal,
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    abort.abort(new TimeoutError(10));
    await assert.rejects(() => step, /Timed out|Aborted/);
    assert.ok(
      calls.some((args) => args[0] === "agent" && args[1] === "send-keys" && args.includes("Escape")),
      `expected Escape interrupt, got ${JSON.stringify(calls)}`,
    );
  } finally {
    releasePrompt?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("markRunInterrupted fails a running bundle", async () => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "phw-interrupt-"));
  const { WorkflowRunStore } = await import("../src/workflows/store.ts");
  const store = new WorkflowRunStore(outputRoot);
  const executor = new FileBackedExecutor();
  executor.hangUntilAbort = true;
  const engine = new WorkflowEngine({ executor, store, maxSteps: 10 });
  const workflow = defineWorkflow({
    name: "interrupt",
    startAt: "work",
    nodes: { work: agent({ spawn: { name: "w" }, prompt: () => "x" }) },
  });
  try {
    const runPromise = engine.run(workflow, {}, { runId: "interrupt-1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    engine.park();
    await runPromise;
    const interrupted = await store.markRunInterrupted("interrupt-1", "host exit");
    assert.ok(interrupted);
    assert.equal(interrupted!.state.status, "failed");
    assert.equal(interrupted!.state.error, "host exit");
    const bundle = await readRunBundle(path.join(outputRoot, "interrupt-1"));
    assert.equal(bundle?.state.status, "failed");
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

function okJson(result: unknown = {}): HerdrExecResult {
  return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
}
