import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import {
  CancelledError,
  TimeoutError,
  WorkflowEngine,
  agent,
  compute,
  defineWorkflow,
  listRunBundles,
  readRunBundle,
  type AgentStepExecutor,
  type AgentStepRequest,
  type AgentStepSubmission,
} from "../src/index.ts";
import { HerdrClient, isHerdrError, makeHerdrError } from "../src/herdr/client.ts";
import { writeFakeAgentResult } from "../src/herdr/executor.ts";

function numberField(value: unknown, key: string): number {
  assert.ok(typeof value === "object" && value !== null && key in value);
  const field = Reflect.get(value, key);
  assert.equal(typeof field, "number");
  return field;
}

class FileBackedExecutor implements AgentStepExecutor {
  request?: AgentStepRequest;

  async runAgentStep(
    request: AgentStepRequest,
    _signal: AbortSignal,
  ): Promise<AgentStepSubmission> {
    this.request = request;
    writeFakeAgentResult({
      resultPath: request.contract.resultPath,
      runId: request.contract.runId,
      nodeId: request.contract.nodeId,
      attemptId: request.contract.attemptId,
      output: { reply: "upstream" },
    });
    const result: unknown = JSON.parse(readFileSync(request.contract.resultPath, "utf8"));
    assert.ok(typeof result === "object" && result !== null && "output" in result);
    const accepted = await request.accept(result.output);
    if (!accepted.ok) throw new Error(accepted.error);
    return { output: accepted.value };
  }
}

test("upstream workflow errors retain stable names and messages", () => {
  const timeout = new TimeoutError(1500);
  assert.equal(timeout.name, "TimeoutError");
  assert.equal(timeout.timeoutMs, 1500);
  assert.match(timeout.message, /1500/);

  const cancelled = new CancelledError("stop");
  assert.equal(cancelled.name, "CancelledError");
  assert.equal(cancelled.message, "stop");
});

test("HerdrError remains a tagged schema error", () => {
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

test("upstream run bundles externalize large prompts and retain resolved spawn", async () => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "phw-upstream-store-"));
  const executor = new FileBackedExecutor();
  const engine = new WorkflowEngine({ executor, outputRoot, maxSteps: 10 });
  const workflow = defineWorkflow({
    name: "upstream-store",
    startAt: "shape",
    nodes: {
      shape: compute({ run: ({ input }) => ({ n: numberField(input, "n") + 1 }) }),
      reply: agent({
        spawn: {
          name: ({ outputs }) => `agent-${numberField(outputs.shape, "n")}`,
          systemPrompt: "Answer exactly.",
          model: "provider/model",
          thinking: "high",
          skills: "how",
          tools: "read,grep",
          extensions: ["/tmp/example-extension.ts"],
          cwd: "/tmp",
          kind: "pi-wiz",
          fork: true,
          interactive: false,
          closePaneAfterDone: true,
        },
        prompt: () => "x".repeat(5000),
      }),
    },
    edges: [{ from: "shape", to: "reply" }],
  });

  try {
    const result = await engine.run(workflow, { n: 1 });
    assert.equal(result.state.status, "completed");
    assert.deepEqual(result.state.finalOutput, { reply: "upstream" });
    assert.equal(executor.request?.spawn.name, "agent-2");
    assert.equal(executor.request?.spawn.kind, "pi-wiz");
    assert.equal(executor.request?.spawn.closePaneAfterDone, true);
    assert.match(executor.request?.contract.resultPath ?? "", /agents\/reply\/[^/]+\/result\.json$/);

    const bundle = await readRunBundle(result.runDir);
    assert.ok(bundle);
    assert.equal(bundle.state.schema, "pi-workflows.run-state.v1");
    assert.ok(bundle.state.traceSeq > 0);
    const persistedPrompt = bundle.state.steps[1]?.prompt;
    assert.ok(typeof persistedPrompt === "object" && persistedPrompt !== null);
    assert.ok("$artifact" in persistedPrompt);

    const snapshot: unknown = JSON.parse(
      readFileSync(path.join(result.runDir, "workflow.json"), "utf8"),
    );
    assert.ok(typeof snapshot === "object" && snapshot !== null && "nodes" in snapshot);
    const nodes = snapshot.nodes;
    assert.ok(typeof nodes === "object" && nodes !== null && "reply" in nodes);
    const reply = nodes.reply;
    assert.ok(typeof reply === "object" && reply !== null && "spawn" in reply);
    assert.deepEqual(reply.spawn, {
      systemPrompt: "Answer exactly.",
      model: "provider/model",
      thinking: "high",
      skills: "how",
      tools: "read,grep",
      extensions: ["/tmp/example-extension.ts"],
      cwd: "/tmp",
      kind: "pi-wiz",
      fork: true,
      interactive: false,
      closePaneAfterDone: true,
    });

    if (process.platform !== "win32") {
      assert.equal(statSync(result.runDir).mode & 0o777, 0o700);
      assert.equal(statSync(path.join(result.runDir, "state.json")).mode & 0o777, 0o600);
    }

    const malformedDir = path.join(outputRoot, "malformed");
    mkdirSync(malformedDir);
    writeFileSync(
      path.join(malformedDir, "manifest.json"),
      JSON.stringify({ schema: "pi-workflows.run-bundle.v1", paths: { state: "../state.json" } }),
    );
    const listed = await listRunBundles(outputRoot);
    assert.deepEqual(listed.map((entry) => entry.runDir), [result.runDir]);
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
