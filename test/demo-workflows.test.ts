import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
  WorkflowEngine,
  loadWorkflowFile,
  workflowFileStem,
  type WorkflowDefinition,
} from "../src/index.ts";
import {
  DemoAgentExecutor,
  listDemoWorkflowFiles,
  runDemoWorkflow,
} from "../scripts/run-demo-workflows.ts";

const DEMO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "demo");
const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function loadDemo(stemSubstring: string): Promise<{
  file: string;
  workflow: WorkflowDefinition;
}> {
  const files = await listDemoWorkflowFiles(DEMO_DIR);
  const file = files.find((candidate) => workflowFileStem(candidate).includes(stemSubstring));
  assert.ok(file, `missing demo workflow matching ${stemSubstring}`);
  return { file, workflow: await loadWorkflowFile(file) };
}

test("discovers all graded demo workflows", async () => {
  const files = await listDemoWorkflowFiles(DEMO_DIR);
  const stems = files.map((file) => workflowFileStem(file));
  assert.deepEqual(stems, [
    "01-compute-pipeline",
    "02-shell-facts",
    "03-timeout-budget",
    "04-spawn-matrix",
    "05-decision-rejoin",
    "06-checkpoint-continue",
    "07-repair-outcome",
    "08-parkable-stages",
  ]);
});

test("01 compute pipeline completes with structured finalOutput", async () => {
  const { file, workflow } = await loadDemo("01-compute-pipeline");
  const result = await runDemoWorkflow({
    workflow,
    workflowPath: file,
    outputRoot: tempRoot("phw-demo-01-"),
    input: { value: "Pi-Herdr" },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.finalOutput, {
    original: "Pi-Herdr",
    normalized: "pi-herdr",
    length: 8,
    summary: '"pi-herdr" (8 chars)',
  });
});

test("02 shell facts completes", async () => {
  const { file, workflow } = await loadDemo("02-shell-facts");
  const result = await runDemoWorkflow({
    workflow,
    workflowPath: file,
    outputRoot: tempRoot("phw-demo-02-"),
    input: { label: "build" },
  });
  assert.equal(result.status, "completed");
  const output = result.finalOutput as {
    label?: string;
    fact?: string;
    n?: number;
    formatted?: string;
  };
  assert.equal(output.label, "build");
  assert.equal(output.fact, "shell-ok");
  assert.equal(output.n, 4);
  assert.equal(output.formatted, "[build] shell-ok (n=4)");
});

test("03 timeout budget uses functional timeoutMs and completes successfully", async () => {
  const { file, workflow } = await loadDemo("03-timeout-budget");
  const result = await runDemoWorkflow({
    workflow,
    workflowPath: file,
    outputRoot: tempRoot("phw-demo-03-"),
    input: { budgetMs: 2_500, tag: "fast" },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.finalOutput, {
    ok: true,
    budgetMs: 2_500,
    tag: "fast",
    signalAborted: false,
  });
});

test("04 spawn matrix completes and captures the full spawn surface", async () => {
  const { file, workflow } = await loadDemo("04-spawn-matrix");
  const executor = new DemoAgentExecutor();
  const result = await runDemoWorkflow({
    workflow,
    workflowPath: file,
    outputRoot: tempRoot("phw-demo-04-"),
    executor,
    input: { echo: "ping" },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.finalOutput, { echo: "ping" });
  assert.ok(executor.lastRequest);
  const spawn = executor.lastRequest!.spawn;
  assert.equal(spawn.name, "spawn-matrix");
  assert.equal(spawn.systemPrompt, "Return only the JSON contract. No tools beyond workflow_done.");
  assert.equal(typeof spawn.model, "string");
  assert.ok(spawn.model!.length > 0);
  assert.equal(spawn.thinking, "low");
  assert.equal(spawn.tools, "workflow_done");
  assert.deepEqual(spawn.extensions, []);
  assert.equal(typeof spawn.cwd, "string");
  assert.ok(spawn.cwd!.length > 0);
  assert.equal(spawn.kind, "pi");
  assert.equal(spawn.fork, false);
  assert.equal(spawn.interactive, false);
  assert.equal(spawn.closePaneAfterDone, true);
  assert.equal(spawn.agent, undefined);
  assert.equal(spawn.skills, undefined);
});

test("05 decision rejoin completes via switch on compute output", async () => {
  const { file, workflow } = await loadDemo("05-decision-rejoin");
  const left = await runDemoWorkflow({
    workflow,
    workflowPath: file,
    outputRoot: tempRoot("phw-demo-05-left-"),
    input: { route: "left" },
  });
  assert.equal(left.status, "completed");
  assert.deepEqual(left.finalOutput, {
    route: "left",
    branch: "left",
    note: "took left path",
  });

  const right = await runDemoWorkflow({
    workflow,
    workflowPath: file,
    outputRoot: tempRoot("phw-demo-05-right-"),
    input: { route: "right" },
  });
  assert.equal(right.status, "completed");
  assert.equal((right.finalOutput as { branch?: string }).branch, "right");
});

test("06 checkpoint reaches waiting then continueRun completes", async () => {
  const { file, workflow } = await loadDemo("06-checkpoint-continue");
  const result = await runDemoWorkflow({
    workflow,
    workflowPath: file,
    outputRoot: tempRoot("phw-demo-06-"),
    input: { topic: "ship demo" },
    continueInput: { decision: "approve" },
  });
  assert.equal(result.status, "waiting");
  assert.equal(result.continuedStatus, "completed");
  const waiting = result.finalOutput as {
    awaiting?: string;
    draft?: { topic?: string; draft?: string };
  };
  assert.equal(waiting.awaiting, "human-approval");
  assert.equal(waiting.draft?.topic, "ship demo");

  const output = result.continuedFinalOutput as {
    approved?: boolean;
    topic?: string;
    draft?: string;
    answer?: unknown;
  };
  assert.equal(output.approved, true);
  assert.equal(output.topic, "ship demo");
  assert.equal(output.draft, "Proposal: ship demo");
  assert.deepEqual(output.answer, { decision: "approve" });
});

test("07 repair outcome: mode ok completes clean; mode fail takes repair compute", async () => {
  const { file, workflow } = await loadDemo("07-repair-outcome");

  const clean = await runDemoWorkflow({
    workflow,
    workflowPath: file,
    outputRoot: tempRoot("phw-demo-07-ok-"),
    input: { mode: "ok" },
  });
  assert.equal(clean.status, "completed");
  assert.equal((clean.finalOutput as { status?: string }).status, "clean");

  const repaired = await runDemoWorkflow({
    workflow,
    workflowPath: file,
    outputRoot: tempRoot("phw-demo-07-fail-"),
    input: { mode: "fail" },
  });
  assert.equal(repaired.status, "completed");
  const output = repaired.finalOutput as {
    status?: string;
    repair?: { diagnosis?: string; retry?: boolean; probeOutcome?: string };
  };
  assert.equal(output.status, "repaired");
  assert.equal(typeof output.repair?.diagnosis, "string");
  assert.equal(output.repair?.retry, true);
  assert.equal(output.repair?.probeOutcome, "failed");
});

test("08 parkable stages: park mid-agent then resumeRun completes", async () => {
  const { workflow } = await loadDemo("08-parkable-stages");
  const outputRoot = tempRoot("phw-demo-08-");
  const hanging = new DemoAgentExecutor();
  hanging.hangUntilAbort = true;

  const engine = new WorkflowEngine({
    executor: hanging,
    outputRoot,
    maxSteps: 20,
  });
  const runPromise = engine.run(
    workflow,
    { seed: "alpha" },
    { runId: "parkable-demo-1", workflowHash: "demo" },
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  engine.park();
  const parked = await runPromise;
  assert.equal(parked.state.status, "running");
  assert.equal(parked.state.currentNode, "midAgent");

  const resumeEngine = new WorkflowEngine({
    executor: new DemoAgentExecutor(),
    outputRoot,
    maxSteps: 20,
  });
  const resumed = await resumeEngine.resumeRun(workflow, "parkable-demo-1", {
    workflowHash: "demo",
  });
  assert.equal(resumed.state.status, "completed");
  assert.deepEqual(resumed.state.finalOutput, {
    stages: ["stage1", "midAgent", "stage2", "stage3"],
    seed: "alpha",
    mid: "alpha",
    packed: "stage2:alpha",
  });
});
