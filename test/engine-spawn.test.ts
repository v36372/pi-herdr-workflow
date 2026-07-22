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
} from "../src/index.ts";
import { writeFakeAgentResult } from "../src/herdr/executor.ts";

class FileBackedExecutor implements AgentStepExecutor {
  lastRequest: AgentStepRequest | null = null;

  async runAgentStep(
    request: AgentStepRequest,
    _signal: AbortSignal,
  ): Promise<AgentStepSubmission> {
    this.lastRequest = request;
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

test("agent node resolves spawn params and result paths", async () => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "phw-"));
  const executor = new FileBackedExecutor();
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
