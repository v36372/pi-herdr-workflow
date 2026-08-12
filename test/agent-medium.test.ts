import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  AgentProtocolExecutor,
  MockAgentExecutor,
  MockAgentMedium,
  WorkflowEngine,
  agent,
  defineWorkflow,
  readResultFile,
} from "../src/index.ts";

function contract(artifactDir: string) {
  return {
    runId: "run-1",
    workflowName: "mock-flow",
    nodeId: "reply",
    attemptId: "12345678-abcd",
    artifactDir,
    resultPath: path.join(artifactDir, "result.json"),
  };
}

function spawn(name = "echo") {
  return {
    name,
    tools: "read,bash",
    extensions: ["/tmp/ask.ts"],
    fork: false as const,
  };
}

test("MockAgentExecutor writes result.json and records spawn", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-mock-"));
  const artifactDir = path.join(root, "agents", "reply", "12345678-abcd");
  const executor = new MockAgentExecutor(() => ({ echo: "pong" }), { cwd: root });
  try {
    const submission = await executor.runAgentStep(
      {
        contract: contract(artifactDir),
        prompt: "say pong",
        spawn: spawn("Scout: Auth"),
        accept: async (output) => ({ ok: true, value: output }),
      },
      new AbortController().signal,
    );
    assert.deepEqual(submission.output, { echo: "pong" });
    assert.equal(executor.mock.starts.length, 1);
    assert.equal(executor.mock.starts[0]?.spawn.name, "Scout: Auth");
    assert.equal(executor.mock.starts[0]?.spawn.tools, "read,bash");
    assert.deepEqual(executor.mock.starts[0]?.spawn.extensions, ["/tmp/ask.ts"]);
    assert.equal(executor.mock.prompts.length, 1);
    assert.equal(executor.mock.prompts[0]?.prompt, "say pong");
    assert.equal(readFileSync(path.join(artifactDir, "task.md"), "utf8"), "say pong");
    assert.ok(existsSync(path.join(artifactDir, "agent-env.sh")));
    assert.ok(readResultFile(path.join(artifactDir, "result.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mock medium retries missing workflow_done then accepts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-mock-miss-"));
  const artifactDir = path.join(root, "agents", "reply", "12345678-abcd");
  const progress: string[] = [];
  const executor = new MockAgentExecutor(
    ({ submission }) => (submission === 1 ? undefined : { recovered: true }),
    {
      cwd: root,
      maxValidationAttempts: 3,
      onProgress: (event) => progress.push(event.phase),
    },
  );
  try {
    const submission = await executor.runAgentStep(
      {
        contract: contract(artifactDir),
        prompt: "call workflow_done",
        spawn: spawn(),
        accept: async (output) => ({ ok: true, value: output }),
      },
      new AbortController().signal,
    );
    assert.deepEqual(submission.output, { recovered: true });
    assert.equal(executor.mock.prompts.length, 2);
    assert.match(executor.mock.prompts[1]!.prompt, /settled without calling workflow_done/);
    assert.equal(
      readFileSync(path.join(artifactDir, "task.md"), "utf8"),
      "call workflow_done",
    );
    assert.match(readFileSync(path.join(artifactDir, "retry-2.md"), "utf8"), /workflow_done/);
    assert.deepEqual(progress, ["agent_start", "agent_prompt", "completion_retry", "result"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mock medium retries validation rejection on the same session", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-mock-val-"));
  const artifactDir = path.join(root, "agents", "reply", "12345678-abcd");
  const executor = new MockAgentExecutor(({ submission }) =>
    submission === 1 ? { score: "bad" } : { score: 42 },
  );
  try {
    const submission = await executor.runAgentStep(
      {
        contract: contract(artifactDir),
        prompt: "numeric score",
        spawn: spawn("scorer"),
        accept: async (output) => {
          const score = (output as { score?: unknown }).score;
          if (typeof score !== "number") {
            return { ok: false, error: "score must be a number" };
          }
          return { ok: true, value: output };
        },
      },
      new AbortController().signal,
    );
    assert.deepEqual(submission.output, { score: 42 });
    assert.equal(executor.mock.starts.length, 1);
    assert.equal(executor.mock.prompts.length, 2);
    assert.match(executor.mock.prompts[1]!.prompt, /score must be a number/);
    assert.match(readFileSync(path.join(artifactDir, "retry-2.md"), "utf8"), /rejected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mock medium fails after the missing workflow_done ceiling", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-mock-cap-"));
  const artifactDir = path.join(root, "agents", "reply", "12345678-abcd");
  const executor = new MockAgentExecutor(() => undefined, { maxValidationAttempts: 2 });
  try {
    await assert.rejects(
      () =>
        executor.runAgentStep(
          {
            contract: contract(artifactDir),
            prompt: "go",
            spawn: spawn(),
            accept: async (output) => ({ ok: true, value: output }),
          },
          new AbortController().signal,
        ),
      /settled without calling workflow_done .* after 2 submission\(s\)/,
    );
    assert.equal(executor.mock.prompts.length, 2);
    assert.equal(existsSync(path.join(artifactDir, "result.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mock medium aborts a hanging handler", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-mock-abort-"));
  const artifactDir = path.join(root, "agents", "reply", "12345678-abcd");
  const executor = new MockAgentExecutor(
    ({ signal }) =>
      new Promise((_, reject) => {
        const onAbort = () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }),
  );
  const controller = new AbortController();
  const run = executor.runAgentStep(
    {
      contract: contract(artifactDir),
      prompt: "hang",
      spawn: spawn("hanger"),
      accept: async (output) => ({ ok: true, value: output }),
    },
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(new Error("stop"));
  await assert.rejects(() => run, /stop|Aborted/);
  rmSync(root, { recursive: true, force: true });
});

test("WorkflowEngine runs an agent node through a mocked medium", async () => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "phw-mock-engine-"));
  const medium = new MockAgentMedium(({ ctx }) => ({
    echo: "ping",
    spawnName: ctx.spawn.name,
  }));
  const executor = new AgentProtocolExecutor({ medium, cwd: outputRoot });
  const engine = new WorkflowEngine({ executor, outputRoot, maxSteps: 10 });
  try {
    const workflow = defineWorkflow({
      name: "mock-echo",
      startAt: "reply",
      nodes: {
        reply: agent({
          spawn: { name: "echo", tools: "workflow_done" },
          prompt: () => "echo ping",
          expectedOutput: `{ "echo": "…" }`,
        }),
      },
      edges: [],
    });
    const { state } = await engine.run(workflow, { echo: "ping" });
    assert.equal(state.status, "completed");
    assert.deepEqual(state.outputs.reply, { echo: "ping", spawnName: "echo" });
    assert.equal(medium.starts[0]?.spawn.name, "echo");
    assert.equal(medium.prompts[0]?.prompt.includes("echo ping"), true);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});
