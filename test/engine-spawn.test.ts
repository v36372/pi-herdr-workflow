import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  WorkflowEngine,
  agent,
  compute,
  defineWorkflow,
  type AgentStepExecutor,
  type AgentStepRequest,
  type AgentStepSubmission,
  type ResolvedAgentSpawn,
} from "../src/index.ts";
import { writeFakeAgentResult } from "../src/herdr/executor.ts";
import { assertValidAgentNode, assertValidWorkflowDefinitionShape } from "../src/workflows/schema.ts";

class CapturingExecutor implements AgentStepExecutor {
  lastRequest: AgentStepRequest | null = null;
  requests: AgentStepRequest[] = [];

  async runAgentStep(
    request: AgentStepRequest,
    _signal: AbortSignal,
  ): Promise<AgentStepSubmission> {
    this.lastRequest = request;
    this.requests.push(request);
    writeFakeAgentResult({
      resultPath: request.contract.resultPath,
      runId: request.contract.runId,
      nodeId: request.contract.nodeId,
      attemptId: request.contract.attemptId,
      output: { reply: "pong", spawnName: request.spawn.name },
    });
    const result = JSON.parse(readFileSync(request.contract.resultPath, "utf8"));
    const accepted = await request.accept(result.output);
    if (!accepted.ok) throw new Error(accepted.error);
    return { output: accepted.value };
  }
}

function runWithSpawn(
  spawn: NonNullable<Parameters<typeof agent>[0]["spawn"]>,
  input: unknown = {},
): Promise<{ spawn: ResolvedAgentSpawn; prompt: string; request: AgentStepRequest }> {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "phw-spawn-"));
  const executor = new CapturingExecutor();
  const engine = new WorkflowEngine({ executor, outputRoot, maxSteps: 10 });
  const workflow = defineWorkflow({
    name: "spawn-matrix",
    startAt: "reply",
    nodes: {
      reply: agent({
        spawn,
        prompt: () => "say pong",
        expectedOutput: `{ "reply": "…" }`,
      }),
    },
  });
  return engine
    .run(workflow, input)
    .then(({ state }) => {
      assert.equal(state.status, "completed");
      assert.ok(executor.lastRequest);
      return {
        spawn: executor.lastRequest!.spawn,
        prompt: executor.lastRequest!.prompt,
        request: executor.lastRequest!,
      };
    })
    .finally(() => {
      rmSync(outputRoot, { recursive: true, force: true });
    });
}

test("agent node resolves spawn params and result paths", async () => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "phw-"));
  const executor = new CapturingExecutor();
  const engine = new WorkflowEngine({ executor, outputRoot, maxSteps: 10 });

  const workflow = defineWorkflow({
    name: "spawn-check",
    startAt: "reply",
    nodes: {
      reply: agent({
        spawn: {
          name: ({ input }) => `agent-${(input as { n: string }).n}`,
          agent: "scout",
          model: "test/model",
          tools: "read,bash",
          fork: false,
        },
        prompt: () => "say pong",
        expectedOutput: `{ "reply": "…" }`,
      }),
      wrap: compute({
        run: ({ outputs }) => ({ final: outputs.reply }),
      }),
    },
    edges: [{ from: "reply", to: "wrap" }],
  });

  try {
    const { state } = await engine.run(workflow, { n: "x" });
    assert.equal(state.status, "completed");
    assert.ok(executor.lastRequest);
    assert.equal(executor.lastRequest!.spawn.name, "agent-x");
    assert.equal(executor.lastRequest!.spawn.agent, "scout");
    assert.equal(executor.lastRequest!.spawn.model, "test/model");
    assert.equal(executor.lastRequest!.spawn.tools, "read,bash");
    assert.match(executor.lastRequest!.contract.resultPath, /agents\/reply\/.+\/result\.json$/);
    assert.deepEqual(state.finalOutput, {
      final: { reply: "pong", spawnName: "agent-x" },
    });
    assert.match(executor.lastRequest!.prompt, /workflow_done/);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("every spawn param resolves into AgentStepRequest.spawn", async () => {
  const { spawn, prompt, request } = await runWithSpawn(
    {
      name: ({ input }) => `Scout: ${(input as { label: string }).label}`,
      agent: "scout",
      systemPrompt: ({ input }) => `Role for ${(input as { label: string }).label}`,
      model: "openai-codex/gpt-5.6-luna",
      thinking: "high",
      skills: "search,review",
      tools: "read,bash,grep",
      extensions: ["/tmp/pi-ask/index.ts", "/tmp/companion.ts"],
      cwd: ({ input }) => `/tmp/work/${(input as { label: string }).label}`,
      kind: "pi-wiz",
      fork: true,
      interactive: true,
      closePaneAfterDone: true,
    },
    { label: "Auth" },
  );

  assert.deepEqual(spawn, {
    name: "Scout: Auth",
    agent: "scout",
    systemPrompt: "Role for Auth",
    model: "openai-codex/gpt-5.6-luna",
    thinking: "high",
    skills: "search,review",
    tools: "read,bash,grep",
    extensions: ["/tmp/pi-ask/index.ts", "/tmp/companion.ts"],
    cwd: "/tmp/work/Auth",
    kind: "pi-wiz",
    fork: true,
    interactive: true,
    closePaneAfterDone: true,
  });
  assert.equal(request.contract.nodeId, "reply");
  assert.match(request.contract.artifactDir, /agents\/reply\//);
  assert.match(prompt, /workflow_done/);
});

test("spawn.name defaults to the node id and fork/closePaneAfterDone default false", async () => {
  const { spawn } = await runWithSpawn({});
  assert.equal(spawn.name, "reply");
  assert.equal(spawn.fork, false);
  assert.equal(spawn.closePaneAfterDone, false);
  assert.equal(spawn.agent, undefined);
  assert.equal(spawn.systemPrompt, undefined);
  assert.equal(spawn.model, undefined);
  assert.equal(spawn.thinking, undefined);
  assert.equal(spawn.skills, undefined);
  assert.equal(spawn.tools, undefined);
  assert.equal(spawn.extensions, undefined);
  assert.equal(spawn.cwd, undefined);
  assert.equal(spawn.kind, undefined);
  assert.equal(spawn.interactive, undefined);
});

test("spawn.name string and empty resolved name are rejected", async () => {
  const { spawn } = await runWithSpawn({ name: "fixed-agent" });
  assert.equal(spawn.name, "fixed-agent");

  await assert.rejects(
    () => runWithSpawn({ name: () => "   " }),
    /resolved an empty spawn\.name/,
  );
});

test("spawn.systemPrompt and spawn.cwd accept static strings", async () => {
  const { spawn } = await runWithSpawn({
    name: "static",
    systemPrompt: "Be concise",
    cwd: "/tmp/project",
  });
  assert.equal(spawn.systemPrompt, "Be concise");
  assert.equal(spawn.cwd, "/tmp/project");
});

test("spawn.kind accepts pi and pi-wiz only", async () => {
  const pi = await runWithSpawn({ name: "a", kind: "pi" });
  assert.equal(pi.spawn.kind, "pi");
  const wiz = await runWithSpawn({ name: "b", kind: "pi-wiz" });
  assert.equal(wiz.spawn.kind, "pi-wiz");

  assert.throws(
    () =>
      assertValidAgentNode(
        agent({
          spawn: { kind: "mux" as "pi" },
          prompt: () => "x",
        }),
      ),
    /spawn\.kind must be "pi" or "pi-wiz"/,
  );
});

test("spawn.extensions must be a non-empty string array when present", () => {
  assert.throws(
    () =>
      assertValidAgentNode(
        agent({
          spawn: { extensions: ["", "/tmp/ok.ts"] },
          prompt: () => "x",
        }),
      ),
    /spawn\.extensions must be an array of non-empty strings/,
  );
  assert.throws(
    () =>
      assertValidAgentNode(
        agent({
          spawn: { extensions: "/tmp/ok.ts" as unknown as string[] },
          prompt: () => "x",
        }),
      ),
    /spawn\.extensions must be an array of non-empty strings/,
  );
});

test("spawn boolean and string fields reject wrong types", () => {
  const cases: Array<{ spawn: Record<string, unknown>; message: RegExp }> = [
    { spawn: { name: 1 }, message: /spawn\.name must be a string or function/ },
    { spawn: { agent: 1 }, message: /spawn\.agent must be a string/ },
    { spawn: { systemPrompt: 1 }, message: /spawn\.systemPrompt must be a string or function/ },
    { spawn: { model: 1 }, message: /spawn\.model must be a string/ },
    { spawn: { thinking: 1 }, message: /spawn\.thinking must be a string/ },
    { spawn: { skills: 1 }, message: /spawn\.skills must be a string/ },
    { spawn: { tools: 1 }, message: /spawn\.tools must be a string/ },
    { spawn: { cwd: 1 }, message: /spawn\.cwd must be a string or function/ },
    { spawn: { fork: "yes" }, message: /spawn\.fork must be a boolean/ },
    { spawn: { interactive: "yes" }, message: /spawn\.interactive must be a boolean/ },
    {
      spawn: { closePaneAfterDone: "yes" },
      message: /spawn\.closePaneAfterDone must be a boolean/,
    },
  ];
  for (const { spawn, message } of cases) {
    assert.throws(
      () =>
        assertValidAgentNode(
          agent({
            spawn: spawn as never,
            prompt: () => "x",
          }),
        ),
      message,
    );
  }
});

test("spawn.fork false and interactive false stay explicit in the resolved spawn", async () => {
  const { spawn } = await runWithSpawn({
    name: "flags",
    fork: false,
    interactive: false,
    closePaneAfterDone: false,
  });
  assert.equal(spawn.fork, false);
  assert.equal(spawn.interactive, false);
  assert.equal(spawn.closePaneAfterDone, false);
});

test("workflow timeoutMs accepts a context callback", async () => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "phw-timeout-fn-"));
  const executor = new CapturingExecutor();
  const engine = new WorkflowEngine({ executor, outputRoot, maxSteps: 10 });
  let seenTimeoutInput: unknown;
  const workflow = defineWorkflow({
    name: "timeout-fn",
    startAt: "reply",
    nodes: {
      reply: agent({
        timeoutMs: ({ input }) => {
          seenTimeoutInput = input;
          return 5_000;
        },
        spawn: { name: "t" },
        prompt: () => "go",
      }),
    },
  });
  try {
    const { state } = await engine.run(workflow, { budget: 5_000 });
    assert.equal(state.status, "completed");
    assert.deepEqual(seenTimeoutInput, { budget: 5_000 });
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("schema allows timeoutMs functions and rejects invalid values", () => {
  assertValidAgentNode(
    agent({
      timeoutMs: () => 1_000,
      prompt: () => "x",
    }),
  );
  assert.throws(
    () =>
      assertValidAgentNode(
        agent({
          timeoutMs: 0,
          prompt: () => "x",
        }),
      ),
    /timeoutMs must be a finite positive number or function/,
  );
});

test("reserved workflow names include answer and status", () => {
  assert.throws(
    () =>
      assertValidWorkflowDefinitionShape(
        defineWorkflow({
          name: "answer",
          startAt: "a",
          nodes: { a: compute({ run: () => ({}) }) },
        }),
      ),
    /reserved/,
  );
  assert.throws(
    () =>
      assertValidWorkflowDefinitionShape(
        defineWorkflow({
          name: "status",
          startAt: "a",
          nodes: { a: compute({ run: () => ({}) }) },
        }),
      ),
    /reserved/,
  );
});
