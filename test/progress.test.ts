import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildNodeProgress,
  formatProgressText,
  orderWorkflowNodes,
  statusMark,
} from "../src/extension/progress.ts";
import { agent, compute, decision, decisionEdge, defineWorkflow } from "../src/index.ts";

const workflow = defineWorkflow({
  name: "file-parity-like",
  startAt: "listExamples",
  nodes: {
    listExamples: agent({
      statusDetail: "List examples/",
      prompt: () => "list examples",
      expectedOutput: `{ "count": 1 }`,
    }),
    listSkills: agent({
      statusDetail: "List skills/",
      prompt: () => "list skills",
      expectedOutput: `{ "count": 2 }`,
    }),
    tally: compute({
      run: () => ({ total: 3, parity: "odd" }),
    }),
    decide: decision({
      statusDetail: "Odd or even total?",
      question: () => "odd or even?",
      choices: ["odd", "even"] as const,
    }),
    succeed: compute({ run: () => ({ ok: true }) }),
    failEven: compute({ run: () => ({ ok: false }) }),
  },
  edges: [
    { from: "listExamples", to: "listSkills" },
    { from: "listSkills", to: "tally" },
    { from: "tally", to: "decide" },
    decisionEdge({
      from: "decide",
      choices: ["odd", "even"] as const,
      cases: { odd: "succeed", even: "failEven" },
    }),
  ],
});

test("orderWorkflowNodes walks from startAt and keeps branch targets", () => {
  assert.deepEqual(orderWorkflowNodes(workflow), [
    "listExamples",
    "listSkills",
    "tally",
    "decide",
    "succeed",
    "failEven",
  ]);
});

test("buildNodeProgress only includes agent/decision nodes", () => {
  const mid = buildNodeProgress({
    workflow,
    phase: "running",
    currentNodeId: "listSkills",
    state: {
      currentNode: "listSkills",
      status: "running",
      results: {
        listExamples: {
          attemptId: "a1",
          nodeId: "listExamples",
          nodeType: "agent",
          outcome: "ok",
          startedAt: "t0",
          finishedAt: "t1",
          output: { count: 1 },
        },
      },
    },
  });
  assert.deepEqual(
    mid.map((n) => n.id),
    ["listExamples", "listSkills", "decide"],
  );
  assert.equal(mid.find((n) => n.id === "listExamples")?.status, "done");
  assert.equal(mid.find((n) => n.id === "listSkills")?.status, "running");
  assert.equal(mid.find((n) => n.id === "decide")?.status, "pending");
  assert.equal(mid.some((n) => n.id === "tally" || n.id === "succeed"), false);

  const done = buildNodeProgress({
    workflow,
    phase: "completed",
    state: {
      status: "completed",
      results: {
        listExamples: result("listExamples", "agent", "ok"),
        listSkills: result("listSkills", "agent", "ok"),
        tally: result("tally", "compute", "ok"),
        decide: result("decide", "agent", "ok"),
        succeed: result("succeed", "compute", "ok"),
      },
    },
  });
  assert.equal(done.find((n) => n.id === "decide")?.status, "done");
  assert.equal(done.every((n) => n.nodeType === "agent"), true);
});

test("formatProgressText lists agent nodes with marks", () => {
  const nodes = buildNodeProgress({
    workflow,
    phase: "running",
    currentNodeId: "decide",
    state: {
      currentNode: "decide",
      status: "running",
      results: {
        listExamples: result("listExamples", "agent", "ok"),
        listSkills: result("listSkills", "agent", "ok"),
        tally: result("tally", "compute", "ok"),
      },
    },
  });
  const text = formatProgressText({
    workflowName: "file-parity-like",
    phase: "running",
    elapsedMs: 160,
    message: "herdr agent prompt decide-ab12 --wait",
    nodes,
    currentNodeId: "decide",
  });
  assert.match(text, /^file-parity-like · running · 0s$/m);
  assert.match(text, new RegExp(`${statusMark("done")} listExamples  List examples/`));
  assert.match(text, new RegExp(`${statusMark("running")} decide  Odd or even total\?`));
  assert.equal(text.includes("herdr"), false);
  assert.equal(text.includes("tally"), false);
  assert.equal(text.includes("failEven"), false);
  assert.equal(statusMark("pending"), "○");
  assert.equal(statusMark("running"), "◉");
  assert.equal(statusMark("done"), "✓");
});

function result(
  nodeId: string,
  nodeType: "agent" | "compute" | "action" | "checkpoint",
  outcome: "ok" | "failed",
) {
  return {
    attemptId: `${nodeId}-a`,
    nodeId,
    nodeType,
    outcome,
    startedAt: "t0",
    finishedAt: "t1",
    output: outcome === "ok" ? {} : undefined,
    ...(outcome === "failed" ? { error: "nope" } : {}),
  };
}
