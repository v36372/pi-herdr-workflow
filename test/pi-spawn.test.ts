import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  PiProcessExecutor,
  applyStandaloneSpawnOverrides,
  buildStandalonePiArgs,
  defaultAgentArgs,
  isInsideHerdr,
  resolvePiInvocation,
  type AgentStartContext,
} from "../src/index.ts";
import { PI_MCP_ADAPTER_SOURCE } from "../src/herdr/pi-args.ts";
import { guessWorkflowOutput } from "../scripts/workflow-stub-model.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const CHILD_EXT = "/tmp/child-extension.ts";

function baseContext(
  spawn: AgentStartContext["spawn"],
  artifactDir: string,
): AgentStartContext {
  return {
    spawn,
    prompt: "do work",
    contract: {
      runId: "run-1",
      workflowName: "spawn-check",
      nodeId: "reply",
      attemptId: "12345678-abcd",
      artifactDir,
      resultPath: path.join(artifactDir, "result.json"),
    },
    taskPath: path.join(artifactDir, "task.md"),
    resultPath: path.join(artifactDir, "result.json"),
    artifactDir,
    childExtensionPath: CHILD_EXT,
    thinking: spawn.thinking,
    appendSystemPrompts: spawn.systemPrompt ? [spawn.systemPrompt] : [],
    ...(spawn.systemPrompt ? { replaceSystemPrompt: undefined } : {}),
  };
}

test("isInsideHerdr requires both HERDR_ENV and HERDR_PANE_ID", () => {
  const prevEnv = process.env.HERDR_ENV;
  const prevPane = process.env.HERDR_PANE_ID;
  try {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_PANE_ID;
    assert.equal(isInsideHerdr(), false);
    process.env.HERDR_ENV = "1";
    assert.equal(isInsideHerdr(), false);
    process.env.HERDR_PANE_ID = "w1:p1";
    assert.equal(isInsideHerdr(), true);
  } finally {
    if (prevEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prevEnv;
    if (prevPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = prevPane;
  }
});

test("defaultAgentArgs maps the full spawn surface to pi CLI flags", () => {
  const artifactDir = mkdtempSync(path.join(tmpdir(), "phw-args-"));
  try {
    const args = defaultAgentArgs(
      baseContext(
        {
          name: "Scout: Auth",
          agent: "scout",
          systemPrompt: "Be brief",
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
        },
        artifactDir,
      ),
    );
    assert.equal(args[0], "--no-session");
    assert.ok(args.includes("-ne"));
    const dashE = args.flatMap((value, index) => (value === "-e" ? [args[index + 1]] : []));
    assert.deepEqual(dashE, [
      CHILD_EXT,
      "/tmp/pi-ask/index.ts",
      "/tmp/companion.ts",
      PI_MCP_ADAPTER_SOURCE,
    ]);
    assert.equal(args[args.indexOf("--model") + 1], "openai-codex/gpt-5.6-luna");
    assert.equal(args[args.indexOf("--thinking") + 1], "high");
    assert.equal(args[args.indexOf("--append-system-prompt") + 1], "Be brief");
    assert.equal(args[args.indexOf("--tools") + 1], "read,bash,grep,workflow_done");
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("buildStandalonePiArgs adds print-mode flags, name, and @prompt file", () => {
  const artifactDir = mkdtempSync(path.join(tmpdir(), "phw-standalone-args-"));
  try {
    const promptFile = path.join(artifactDir, "task.md");
    const args = buildStandalonePiArgs(
      baseContext(
        {
          name: "echo-agent",
          model: "workflow-stub/echo",
          tools: "workflow_done",
          fork: false,
        },
        artifactDir,
      ),
      { promptFile, offline: true },
    );
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("--no-context-files"));
    assert.ok(args.includes("--offline"));
    assert.ok(args.includes("-a"));
    assert.equal(args[args.indexOf("--name") + 1], "echo-agent");
    assert.equal(args.at(-1), `@${promptFile}`);
    assert.ok(args.includes("--no-session"));
    assert.equal(args.includes("--fork"), false);
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("buildStandalonePiArgs uses --fork and drops --no-session", () => {
  const artifactDir = mkdtempSync(path.join(tmpdir(), "phw-fork-args-"));
  try {
    const args = buildStandalonePiArgs(
      baseContext({ name: "forked", fork: true }, artifactDir),
      { promptFile: "/tmp/task.md", forkSessionFile: "/tmp/parent.jsonl" },
    );
    assert.equal(args.includes("--no-session"), false);
    assert.equal(args[args.indexOf("--fork") + 1], "/tmp/parent.jsonl");
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("buildStandalonePiArgs throws when fork is set without a session file", () => {
  const artifactDir = mkdtempSync(path.join(tmpdir(), "phw-fork-missing-"));
  try {
    assert.throws(
      () =>
        buildStandalonePiArgs(baseContext({ name: "forked", fork: true }, artifactDir), {
          promptFile: "/tmp/task.md",
        }),
      /spawn.fork requires a persisted orchestrator session file/,
    );
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("resolvePiInvocation prefers PI_BIN then a running pi CLI script", () => {
  const prev = process.env.PI_BIN;
  try {
    process.env.PI_BIN = "/opt/pi --debug";
    assert.deepEqual(resolvePiInvocation(["-p"]), {
      command: "/opt/pi",
      args: ["--debug", "-p"],
    });
    delete process.env.PI_BIN;
    const resolved = resolvePiInvocation(["-p"]);
    assert.ok(resolved.command === "pi" || resolved.args.includes("-p"));
  } finally {
    if (prev === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = prev;
  }
});

test("applyStandaloneSpawnOverrides appends stub extension and model", () => {
  const next = applyStandaloneSpawnOverrides(
    {
      name: "echo",
      extensions: ["/tmp/ask.ts"],
      model: "openai-codex/gpt-5.6-luna",
      fork: false,
    },
    {
      extraChildExtensions: ["/tmp/ask.ts", "/tmp/stub.ts"],
      modelOverride: "workflow-stub/echo",
    },
  );
  assert.deepEqual(next.extensions, ["/tmp/ask.ts", "/tmp/stub.ts"]);
  assert.equal(next.model, "workflow-stub/echo");
});

test("PiProcessExecutor spawns vanilla pi with every spawn field", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-pi-spawn-"));
  const artifactDir = path.join(root, "agents", "reply", "12345678-abcd");
  const workCwd = path.join(root, "work");
  mkdirSync(workCwd);
  const executor = new PiProcessExecutor({
    cwd: root,
    resolvePi: (args) => ({ command: process.execPath, args: [FAKE_PI, ...args] }),
    env: { ...process.env, PI_FAKE_PI_OUTPUT: JSON.stringify({ echo: "pong" }) },
  });
  try {
    const submission = await executor.runAgentStep(
      {
        contract: {
          runId: "run-1",
          workflowName: "spawn-matrix",
          nodeId: "reply",
          attemptId: "12345678-abcd",
          artifactDir,
          resultPath: path.join(artifactDir, "result.json"),
        },
        prompt: "echo pong",
        spawn: {
          name: "Scout: Auth",
          systemPrompt: "Return JSON only",
          model: "openai-codex/gpt-5.6-luna",
          thinking: "low",
          tools: "read,bash",
          extensions: ["/tmp/pi-ask.ts"],
          cwd: workCwd,
          kind: "pi",
          fork: false,
          interactive: false,
          closePaneAfterDone: true,
        },
        accept: async (output) => ({ ok: true, value: output }),
      },
      new AbortController().signal,
    );
    assert.deepEqual(submission.output, { echo: "pong" });
    assert.ok(executor.lastLaunch);
    const { args, cwd, env, spawn } = executor.lastLaunch;
    assert.equal(cwd, workCwd);
    assert.equal(spawn.name, "Scout: Auth");
    assert.equal(spawn.model, "openai-codex/gpt-5.6-luna");
    assert.equal(spawn.thinking, "low");
    assert.equal(spawn.tools, "read,bash");
    assert.deepEqual(spawn.extensions, ["/tmp/pi-ask.ts"]);
    assert.equal(spawn.kind, "pi");
    assert.equal(spawn.fork, false);
    assert.equal(spawn.interactive, false);
    assert.equal(spawn.closePaneAfterDone, true);
    assert.ok(args.includes("-ne"));
    assert.ok(args.includes("-p"));
    assert.equal(args[args.indexOf("--model") + 1], "openai-codex/gpt-5.6-luna");
    assert.equal(args[args.indexOf("--thinking") + 1], "low");
    assert.equal(args[args.indexOf("--name") + 1], "Scout: Auth");
    assert.equal(args[args.indexOf("--tools") + 1], "read,bash,workflow_done");
    assert.ok(args.includes("/tmp/pi-ask.ts"));
    assert.equal(env.PI_WORKFLOW_NODE_ID, "reply");
    assert.equal(env.PI_WORKFLOW_RUN_ID, "run-1");
    const recorded = JSON.parse(readFileSync(path.join(artifactDir, "spawn.json"), "utf8"));
    assert.equal(recorded.spawn.name, "Scout: Auth");
    assert.equal(readFileSync(path.join(artifactDir, "task.md"), "utf8"), "echo pong");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PiProcessExecutor retries missing workflow_done then accepts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-pi-missing-"));
  const artifactDir = path.join(root, "agents", "reply", "aaaaaaaa-bbbb");
  const executor = new PiProcessExecutor({
    cwd: root,
    resolvePi: (args) => ({ command: process.execPath, args: [FAKE_PI, ...args] }),
    env: { ...process.env, PI_FAKE_PI_SKIP_RESULT: "1" },
    maxValidationAttempts: 2,
  });
  try {
    await assert.rejects(
      () =>
        executor.runAgentStep(
          {
            contract: {
              runId: "run-2",
              workflowName: "spawn-check",
              nodeId: "reply",
              attemptId: "aaaaaaaa-bbbb",
              artifactDir,
              resultPath: path.join(artifactDir, "result.json"),
            },
            prompt: "go",
            spawn: { name: "retry-agent", tools: "workflow_done", fork: false },
            accept: async (output) => ({ ok: true, value: output }),
          },
          new AbortController().signal,
        ),
      /settled without calling workflow_done/,
    );
    assert.equal(executor.launches.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PiProcessExecutor retries validation rejection on a new child", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-pi-validate-"));
  const artifactDir = path.join(root, "agents", "reply", "cccccccc-dddd");
  const executor = new PiProcessExecutor({
    cwd: root,
    resolvePi: (args) => ({ command: process.execPath, args: [FAKE_PI, ...args] }),
    env: { ...process.env, PI_FAKE_PI_FAIL_FIRST: "1" },
    maxValidationAttempts: 3,
  });
  try {
    const submission = await executor.runAgentStep(
      {
        contract: {
          runId: "run-3",
          workflowName: "spawn-check",
          nodeId: "reply",
          attemptId: "cccccccc-dddd",
          artifactDir,
          resultPath: path.join(artifactDir, "result.json"),
        },
        prompt: "score",
        spawn: { name: "scorer", tools: "workflow_done", fork: false },
        accept: async (output) => {
          if (
            output &&
            typeof output === "object" &&
            typeof (output as { score?: unknown }).score === "number"
          ) {
            return { ok: true, value: output };
          }
          return { ok: false, error: "score must be a number" };
        },
      },
      new AbortController().signal,
    );
    assert.deepEqual(submission.output, { score: 42 });
    assert.equal(executor.launches.length, 2);
    assert.ok(readFileSync(path.join(artifactDir, "retry-2.md"), "utf8").includes("rejected"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PiProcessExecutor aborts a running child", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-pi-abort-"));
  const artifactDir = path.join(root, "agents", "reply", "eeeeeeee-ffff");
  const executor = new PiProcessExecutor({
    cwd: root,
    resolvePi: (args) => ({ command: process.execPath, args: [FAKE_PI, ...args] }),
    env: { ...process.env, PI_FAKE_PI_SLEEP_MS: "30000", PI_FAKE_PI_SKIP_RESULT: "1" },
    completionTimeoutMs: 60_000,
  });
  const controller = new AbortController();
  const run = executor.runAgentStep(
    {
      contract: {
        runId: "run-4",
        workflowName: "spawn-check",
        nodeId: "reply",
        attemptId: "eeeeeeee-ffff",
        artifactDir,
        resultPath: path.join(artifactDir, "result.json"),
      },
      prompt: "hang",
      spawn: { name: "hanger", fork: false },
      accept: async (output) => ({ ok: true, value: output }),
    },
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort(new Error("stop"));
  await assert.rejects(() => run, /stop|Aborted/);
  rmSync(root, { recursive: true, force: true });
});

test("stub guessWorkflowOutput covers echo, shout, decision, and reply", () => {
  assert.deepEqual(
    guessWorkflowOutput('Echo this exact string in the echo field: "ping"'),
    { echo: "ping" },
  );
  assert.deepEqual(guessWorkflowOutput('Echo seed "alpha" in the echo field.'), {
    echo: "alpha",
  });
  assert.deepEqual(guessWorkflowOutput("Previous node picked the word: ocean\nuppercased"), {
    shout: "OCEAN",
  });
  assert.deepEqual(
    guessWorkflowOutput('Answer by picking exactly one of: "heads" | "tails".'),
    { route: "heads", reason: "stub" },
  );
  assert.equal(
    (guessWorkflowOutput("Answer concisely: say hello in one sentence\n---") as { reply: string })
      .reply,
    "say hello in one sentence",
  );
});
