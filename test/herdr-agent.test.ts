import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HerdrClient, HerdrError, isHerdrError, type HerdrExecResult } from "../src/herdr/client.ts";
import {
  DEFAULT_MAX_VALIDATION_ATTEMPTS,
  HerdrStepExecutor,
  writeFakeAgentResult,
} from "../src/herdr/executor.ts";
import { clearResultFile, readResultFile } from "../src/herdr/result-file.ts";

function okJson(result: unknown = {}): HerdrExecResult {
  return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
}

function errJson(code: string, message: string, exitCode = 1): HerdrExecResult {
  return {
    code: exitCode,
    stdout: JSON.stringify({ error: { code, message }, id: `cli:test:${code}` }),
    stderr: "",
  };
}

function baseContract(artifactDir: string, resultPath: string) {
  return {
    runId: "run-1",
    workflowName: "review-flow",
    nodeId: "review",
    attemptId: "12345678-abcd",
    artifactDir,
    resultPath,
  };
}

test("executor starts and prompts pi through Herdr 0.7.5 agent facade", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-agent-"));
  const artifactDir = path.join(root, "agents", "review", "12345678-abcd");
  const resultPath = path.join(artifactDir, "result.json");
  const calls: string[][] = [];
  const progress: string[] = [];
  const client = new HerdrClient({
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "workspace" && args[1] === "create") {
        return okJson({
          workspace: { workspace_id: "w1" },
          root_pane: { pane_id: "w1:p1" },
        });
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        writeFakeAgentResult({
          resultPath,
          runId: "run-1",
          nodeId: "review",
          attemptId: "12345678-abcd",
          output: { verdict: "ok" },
        });
      }
      return okJson();
    },
  });
  const executor = new HerdrStepExecutor({
    originFocus: {},
    client,
    cwd: root,
    onProgress: (event) => progress.push(event.phase),
  });

  try {
    const submission = await executor.runAgentStep(
      {
        contract: baseContract(artifactDir, resultPath),
        prompt: "Review the change and call workflow_done.",
        spawn: {
          name: "Scout: Auth",
          tools: "read",
          fork: false,
        },
        accept: async (output) => ({ ok: true, value: output }),
      },
      new AbortController().signal,
    );

    assert.deepEqual(submission.output, { verdict: "ok" });
    const start = calls.find((args) => args[0] === "agent" && args[1] === "start");
    assert.ok(start);
    assert.deepEqual(start!.slice(0, 8), [
      "agent",
      "start",
      "scout-auth-12345678",
      "--kind",
      "pi",
      "--pane",
      "w1:p1",
      "--",
    ]);
    assert.ok(start!.includes("--no-session"));
    assert.ok(start!.includes("-ne"));
    assert.equal(start![start!.indexOf("--tools") + 1], "read,workflow_done");

    const prompt = calls.find((args) => args[0] === "agent" && args[1] === "prompt");
    assert.ok(prompt);
    assert.equal(prompt![2], "scout-auth-12345678");
    assert.equal(prompt![3], "Review the change and call workflow_done.");
    assert.ok(prompt!.includes("--wait"));
    assert.deepEqual(progress, ["agent_start", "agent_prompt", "result"]);
    assert.equal(
      calls.some((args) => args[0] === "pane" && args[1] === "run" && args.includes("pi")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor merges named agent defaults and preloads requested skills", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-defaults-"));
  const cwd = path.join(root, "work");
  const artifactDir = path.join(root, "artifacts", "inspect", "abcdef12-run");
  const resultPath = path.join(artifactDir, "result.json");
  const agentDir = path.join(root, ".pi", "agents");
  const skillDir = path.join(cwd, ".pi", "skills", "workflow-test-skill");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, "researcher.md"),
    `---\nname: researcher\nmodel: test/default-model\nthinking: high\ntools: read,bash\ncwd: ./work\nsystem-prompt: replace\n---\n\nYou are the research specialist.\n`,
  );
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: workflow-test-skill\ndescription: Test workflow skill loading.\n---\n\nFollow the workflow test procedure.\n`,
  );

  const calls: string[][] = [];
  const client = new HerdrClient({
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "workspace" && args[1] === "create") {
        return okJson({
          workspace: { workspace_id: "w2" },
          root_pane: { pane_id: "w2:p1" },
        });
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        writeFakeAgentResult({
          resultPath,
          runId: "run-2",
          nodeId: "inspect",
          attemptId: "abcdef12-run",
          output: { loaded: true },
        });
      }
      return okJson();
    },
  });
  const executor = new HerdrStepExecutor({
    originFocus: {},
    client,
    cwd: root,
  });

  try {
    const submission = await executor.runAgentStep(
      {
        contract: {
          runId: "run-2",
          workflowName: "defaults-flow",
          nodeId: "inspect",
          attemptId: "abcdef12-run",
          artifactDir,
          resultPath,
        },
        prompt: "Inspect the target and call workflow_done.",
        spawn: {
          name: "Researcher",
          agent: "researcher",
          systemPrompt: "Return concise evidence.",
          skills: "workflow-test-skill",
          fork: false,
        },
        accept: async (output) => ({ ok: true, value: output }),
      },
      new AbortController().signal,
    );

    assert.deepEqual(submission.output, { loaded: true });
    const workspace = calls.find((args) => args[0] === "workspace" && args[1] === "create");
    assert.ok(workspace);
    assert.equal(workspace![workspace!.indexOf("--cwd") + 1], cwd);

    const start = calls.find((args) => args[0] === "agent" && args[1] === "start");
    assert.ok(start);
    assert.equal(start![start!.indexOf("--model") + 1], "test/default-model");
    assert.equal(start![start!.indexOf("--thinking") + 1], "high");
    assert.equal(start![start!.indexOf("--tools") + 1], "read,bash,workflow_done");
    assert.equal(
      start![start!.indexOf("--system-prompt") + 1],
      "You are the research specialist.",
    );
    assert.equal(
      start![start!.indexOf("--append-system-prompt") + 1],
      "Return concise evidence.",
    );

    const promptCall = calls.find((args) => args[0] === "agent" && args[1] === "prompt");
    assert.ok(promptCall);
    assert.match(promptCall![3]!, /<skill name="workflow-test-skill"/);
    assert.match(promptCall![3]!, /References are relative to .*workflow-test-skill/);
    assert.match(promptCall![3]!, /Follow the workflow test procedure\./);
    assert.match(promptCall![3]!, /Inspect the target and call workflow_done\.$/);
    assert.equal(readFileSync(path.join(artifactDir, "task.md"), "utf8"), promptCall![3]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor re-prompts the same agent on validation failure and clears stale results", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-retry-"));
  const artifactDir = path.join(root, "agents", "review", "12345678-abcd");
  const resultPath = path.join(artifactDir, "result.json");
  const promptCalls: string[] = [];
  const progress: Array<{ phase: string; submission?: number }> = [];
  let promptCount = 0;

  const client = new HerdrClient({
    exec: async (args) => {
      if (args[0] === "workspace" && args[1] === "create") {
        return okJson({
          workspace: { workspace_id: "w3" },
          root_pane: { pane_id: "w3:p1" },
        });
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        promptCount += 1;
        promptCalls.push(args[3]!);
        // Simulate a stale rejected payload still on disk when the wait returns.
        // The executor must clear it before accepting a later submission.
        if (promptCount === 1) {
          writeFakeAgentResult({
            resultPath,
            runId: "run-1",
            nodeId: "review",
            attemptId: "12345678-abcd",
            output: { score: "bad" },
          });
        } else {
          // Prove stale content was cleared before the second wait resolved.
          assert.equal(existsSync(resultPath), false);
          writeFakeAgentResult({
            resultPath,
            runId: "run-1",
            nodeId: "review",
            attemptId: "12345678-abcd",
            output: { score: 42 },
          });
        }
      }
      return okJson();
    },
  });
  const executor = new HerdrStepExecutor({
    originFocus: {},
    client,
    cwd: root,
    maxValidationAttempts: 3,
    onProgress: (event) => progress.push({ phase: event.phase, submission: event.submission }),
  });

  try {
    const submission = await executor.runAgentStep(
      {
        contract: baseContract(artifactDir, resultPath),
        prompt: "Return a numeric score via workflow_done.",
        spawn: { name: "scorer", tools: "read", fork: false },
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
    assert.equal(promptCount, 2);
    assert.equal(promptCalls[0], "Return a numeric score via workflow_done.");
    assert.match(promptCalls[1]!, /score must be a number/);
    assert.match(promptCalls[1]!, /Submission 1 of 3/);
    assert.match(promptCalls[1]!, /result\.json was cleared/);
    // task.md remains the original submitted task, not the retry prompt.
    assert.equal(
      readFileSync(path.join(artifactDir, "task.md"), "utf8"),
      "Return a numeric score via workflow_done.",
    );
    assert.deepEqual(
      progress.map((event) => event.phase),
      ["agent_start", "agent_prompt", "validation_retry", "result"],
    );
    assert.equal(progress[2]?.submission, 2);
    assert.ok(readResultFile(resultPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor fails after the validation attempt ceiling", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-retry-cap-"));
  const artifactDir = path.join(root, "agents", "review", "12345678-abcd");
  const resultPath = path.join(artifactDir, "result.json");
  let promptCount = 0;
  const client = new HerdrClient({
    exec: async (args) => {
      if (args[0] === "workspace" && args[1] === "create") {
        return okJson({
          workspace: { workspace_id: "w4" },
          root_pane: { pane_id: "w4:p1" },
        });
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        promptCount += 1;
        writeFakeAgentResult({
          resultPath,
          runId: "run-1",
          nodeId: "review",
          attemptId: "12345678-abcd",
          output: { score: "still-bad" },
        });
      }
      return okJson();
    },
  });
  const executor = new HerdrStepExecutor({
    originFocus: {},
    client,
    cwd: root,
    maxValidationAttempts: 2,
  });

  try {
    await assert.rejects(
      () =>
        executor.runAgentStep(
          {
            contract: baseContract(artifactDir, resultPath),
            prompt: "Return a numeric score via workflow_done.",
            spawn: { name: "scorer", tools: "read", fork: false },
            accept: async () => ({ ok: false, error: "score must be a number" }),
          },
          new AbortController().signal,
        ),
      /Agent output rejected after 2 submission\(s\): score must be a number/,
    );
    assert.equal(promptCount, 2);
    assert.equal(existsSync(resultPath), false);
    assert.equal(DEFAULT_MAX_VALIDATION_ATTEMPTS, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HerdrClient preserves machine-readable error codes", async () => {
  const client = new HerdrClient({
    exec: async (args) => {
      if (args[1] === "prompt") {
        return errJson("agent_prompt_stalled", "agent did not start working");
      }
      if (args[1] === "wait") {
        return errJson("agent_not_running", "agent is no longer running in the target pane");
      }
      if (args[1] === "start") {
        return errJson("protocol_mismatch", "client and server protocol differ");
      }
      return okJson();
    },
  });

  await assert.rejects(
    () => client.agentPrompt("demo", "hi", { wait: true }),
    (error: unknown) => {
      assert.ok(isHerdrError(error));
      assert.equal((error as HerdrError).code, "agent_prompt_stalled");
      assert.match((error as HerdrError).message, /did not start working/);
      assert.equal((error as HerdrError).id, "cli:test:agent_prompt_stalled");
      return true;
    },
  );

  await assert.rejects(
    () => client.agentWait("demo", ["idle"], 1000),
    (error: unknown) => {
      assert.ok(isHerdrError(error));
      assert.equal((error as HerdrError).code, "agent_not_running");
      return true;
    },
  );

  await assert.rejects(
    () => client.agentStart({ name: "demo", kind: "pi", paneId: "w:p" }),
    (error: unknown) => {
      assert.ok(isHerdrError(error));
      assert.equal((error as HerdrError).code, "protocol_mismatch");
      return true;
    },
  );
});

test("HerdrClient.exec raises typed errors for zero-exit JSON envelopes", async () => {
  const client = new HerdrClient({
    exec: async (args) => {
      if (args[0] === "agent" && args[1] === "prompt") {
        return errJson("agent_prompt_stalled", "no state change observed", 0);
      }
      if (args[0] === "agent" && args[1] === "read") {
        // Ordinary text must not be treated as an error envelope.
        return { code: 0, stdout: "plain agent transcript\n", stderr: "" };
      }
      return okJson();
    },
  });

  await assert.rejects(
    () => client.agentPrompt("demo", "hi", { wait: true }),
    (error: unknown) => {
      assert.ok(isHerdrError(error));
      assert.equal((error as HerdrError).code, "agent_prompt_stalled");
      assert.equal((error as HerdrError).exitCode, 0);
      assert.match((error as HerdrError).message, /no state change observed/);
      assert.equal((error as HerdrError).id, "cli:test:agent_prompt_stalled");
      return true;
    },
  );

  const text = await client.agentRead("demo");
  assert.equal(text, "plain agent transcript\n");
});

test("executor maps actionable Herdr error codes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-err-"));
  const artifactDir = path.join(root, "agents", "review", "12345678-abcd");
  const resultPath = path.join(artifactDir, "result.json");
  const client = new HerdrClient({
    exec: async (args) => {
      if (args[0] === "workspace" && args[1] === "create") {
        return okJson({
          workspace: { workspace_id: "w5" },
          root_pane: { pane_id: "w5:p1" },
        });
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        return errJson("agent_prompt_stalled", "no state change observed");
      }
      return okJson();
    },
  });
  const executor = new HerdrStepExecutor({
    originFocus: {},
    client,
    cwd: root,
  });

  try {
    await assert.rejects(
      () =>
        executor.runAgentStep(
          {
            contract: baseContract(artifactDir, resultPath),
            prompt: "do work",
            spawn: { name: "worker", tools: "read", fork: false },
            accept: async (output) => ({ ok: true, value: output }),
          },
          new AbortController().signal,
        ),
      (error: unknown) => {
        assert.ok(isHerdrError(error));
        assert.equal((error as HerdrError).code, "agent_prompt_stalled");
        assert.match((error as HerdrError).message, /did not begin working/);
        assert.match((error as HerdrError).message, /blocked on a prompt/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("client agent read/send-keys use the agent facade", async () => {
  const calls: string[][] = [];
  const client = new HerdrClient({
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "agent" && args[1] === "read") {
        return { code: 0, stdout: "agent transcript\n", stderr: "" };
      }
      return okJson();
    },
  });

  const text = await client.agentRead("demo-agent", { source: "recent", lines: 12 });
  await client.agentSendKeys("demo-agent", ["C-c", "Enter"]);
  assert.equal(text, "agent transcript\n");
  assert.deepEqual(calls[0], ["agent", "read", "demo-agent", "--source", "recent", "--lines", "12"]);
  assert.deepEqual(calls[1], ["agent", "send-keys", "demo-agent", "C-c", "Enter"]);
});

test("clearResultFile removes rejected payloads", () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-clear-"));
  const resultPath = path.join(root, "result.json");
  writeFakeAgentResult({
    resultPath,
    runId: "r",
    nodeId: "n",
    attemptId: "a",
    output: { stale: true },
  });
  assert.ok(readResultFile(resultPath));
  clearResultFile(resultPath);
  assert.equal(readResultFile(resultPath), null);
  clearResultFile(resultPath); // idempotent
  rmSync(root, { recursive: true, force: true });
});

test("dispose closes a run tab in the origin workspace without workspace.close", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-dispose-tab-"));
  const artifactDir = path.join(root, "agents", "review", "12345678-abcd");
  const resultPath = path.join(artifactDir, "result.json");
  const calls: string[][] = [];
  const client = new HerdrClient({
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "tab" && args[1] === "create") {
        return okJson({
          tab: { tab_id: "w-origin:t-run", workspace_id: "w-origin" },
          root_pane: { pane_id: "w-origin:p-run" },
        });
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        writeFakeAgentResult({
          resultPath,
          runId: "run-1",
          nodeId: "review",
          attemptId: "12345678-abcd",
          output: { ok: true },
        });
      }
      return okJson();
    },
  });
  const executor = new HerdrStepExecutor({
    client,
    cwd: root,
    originFocus: { workspaceId: "w-origin", tabId: "w-origin:t1" },
    closeWorkspaceOnDispose: true,
  });

  try {
    await executor.runAgentStep(
      {
        contract: baseContract(artifactDir, resultPath),
        prompt: "do work",
        spawn: { name: "worker", tools: "read", fork: false },
        accept: async (output) => ({ ok: true, value: output }),
      },
      new AbortController().signal,
    );
    await executor.dispose();

    assert.equal(
      calls.some((args) => args[0] === "workspace" && args[1] === "create"),
      false,
    );
    assert.equal(
      calls.some((args) => args[0] === "workspace" && args[1] === "close"),
      false,
    );
    const layoutCalls = calls.filter(
      (args) =>
        (args[0] === "tab" && args[1] === "create") ||
        (args[0] === "workspace" && args[1] === "focus") ||
        (args[0] === "tab" && args[1] === "focus") ||
        (args[0] === "tab" && args[1] === "close"),
    );
    // Host in origin workspace tab; restore after step; restore then close tab.
    assert.deepEqual(layoutCalls, [
      ["tab", "create", "--workspace", "w-origin", "--cwd", root, "--label", "wf:run-1", "--no-focus"],
      ["workspace", "focus", "w-origin"],
      ["tab", "focus", "w-origin:t1"],
      ["workspace", "focus", "w-origin"],
      ["tab", "focus", "w-origin:t1"],
      ["tab", "close", "w-origin:t-run"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("spawn.kind pi-wiz still starts Herdr kind pi and sources wiz env", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-pi-wiz-"));
  const artifactDir = path.join(root, "agents", "wiz", "12345678-abcd");
  const resultPath = path.join(artifactDir, "result.json");
  const calls: string[][] = [];
  const progress: string[] = [];
  const client = new HerdrClient({
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "workspace" && args[1] === "create") {
        return okJson({
          workspace: { workspace_id: "w1" },
          root_pane: { pane_id: "w1:p1" },
        });
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        writeFakeAgentResult({
          resultPath,
          runId: "run-1",
          nodeId: "wiz",
          attemptId: "12345678-abcd",
          output: { ok: true },
        });
      }
      return okJson();
    },
  });
  const executor = new HerdrStepExecutor({
    originFocus: {},
    client,
    cwd: root,
    onProgress: (event) => progress.push(event.message),
  });

  try {
    await executor.runAgentStep(
      {
        contract: {
          ...baseContract(artifactDir, resultPath),
          nodeId: "wiz",
        },
        prompt: "check wiz",
        spawn: {
          name: "Morning: Wiz",
          kind: "pi-wiz",
          tools: "mcp,read",
          fork: false,
        },
        accept: async (output) => ({ ok: true, value: output }),
      },
      new AbortController().signal,
    );

    const start = calls.find((args) => args[0] === "agent" && args[1] === "start");
    assert.ok(start);
    assert.equal(start![start!.indexOf("--kind") + 1], "pi");
    assert.ok(
      progress.some((message) => message.includes("--kind pi") && message.includes("workflow kind pi-wiz")),
    );

    const envPath = path.join(artifactDir, "agent-env.sh");
    assert.equal(existsSync(envPath), true);
    const envScript = readFileSync(envPath, "utf8");
    assert.match(envScript, /spawn\.kind=pi-wiz/);
    assert.match(envScript, /\.config\/wiz-mcp\/env\.zsh/);

    // pi-wiz must load pi-mcp-adapter so the mcp tool exists for Wiz.
    // `pi -e` accepts package sources (https:// / git: / npm:), not only paths.
    const dashE = start!.reduce<number[]>((idxs, arg, i) => {
      if (arg === "-e") idxs.push(i);
      return idxs;
    }, []);
    assert.ok(dashE.length >= 2, `expected >=2 -e args, got ${JSON.stringify(start)}`);
    const extensionSources = dashE.map((i) => start![i + 1]!);
    assert.ok(
      extensionSources.includes("https://github.com/nicobailon/pi-mcp-adapter"),
      `expected pi-mcp-adapter package source in ${JSON.stringify(extensionSources)}`,
    );
    // Default: leave pane open for collaboration.
    assert.equal(calls.some((args) => args[0] === "pane" && args[1] === "close"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("spawn.closePaneAfterDone keeps the last pane open", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-close-pane-"));
  const attempts = ["11111111-abcd", "22222222-abcd", "33333333-abcd"].map(
    (attemptId, index) => {
      const nodeId = `worker-${index + 1}`;
      const artifactDir = path.join(root, "agents", nodeId, attemptId);
      return { nodeId, attemptId, artifactDir, resultPath: path.join(artifactDir, "result.json") };
    },
  );
  const calls: string[][] = [];
  let promptIndex = 0;
  let splitCount = 0;
  const client = new HerdrClient({
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "workspace" && args[1] === "create") {
        return okJson({
          workspace: { workspace_id: "w1" },
          root_pane: { pane_id: "w1:p1" },
        });
      }
      if (args[0] === "pane" && args[1] === "split") {
        splitCount += 1;
        return okJson({ pane: { pane_id: `w1:p${splitCount + 1}` } });
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        const attempt = attempts[promptIndex++]!;
        writeFakeAgentResult({
          resultPath: attempt.resultPath,
          runId: "run-1",
          nodeId: attempt.nodeId,
          attemptId: attempt.attemptId,
          output: { ok: true },
        });
      }
      return okJson();
    },
  });
  const executor = new HerdrStepExecutor({
    originFocus: {},
    client,
    cwd: root,
  });

  try {
    for (const [index, attempt] of attempts.entries()) {
      await executor.runAgentStep(
        {
          contract: {
            runId: "run-1",
            workflowName: "review-flow",
            ...attempt,
          },
          prompt: "do work",
          spawn: {
            name: attempt.nodeId,
            tools: "read",
            fork: false,
            closePaneAfterDone: true,
          },
          accept: async (output) => ({ ok: true, value: output }),
        },
        new AbortController().signal,
      );
      if (index === 0) {
        assert.equal(calls.some((args) => args[0] === "pane" && args[1] === "close"), false);
      }
    }

    const splits = calls.filter((args) => args[0] === "pane" && args[1] === "split");
    assert.deepEqual(splits.map((args) => args[2]), ["w1:p1", "w1:p1"]);
    assert.deepEqual(
      calls.filter((args) => args[0] === "pane" && args[1] === "close"),
      [
        ["pane", "close", "w1:p2"],
        ["pane", "close", "w1:p3"],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispose restores origin focus before and after fallback workspace.close", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phw-dispose-ws-"));
  const artifactDir = path.join(root, "agents", "review", "12345678-abcd");
  const resultPath = path.join(artifactDir, "result.json");
  const calls: string[][] = [];
  const client = new HerdrClient({
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "workspace" && args[1] === "create") {
        return okJson({
          workspace: { workspace_id: "w-run" },
          root_pane: { pane_id: "w-run:p1" },
        });
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        writeFakeAgentResult({
          resultPath,
          runId: "run-1",
          nodeId: "review",
          attemptId: "12345678-abcd",
          output: { ok: true },
        });
      }
      return okJson();
    },
  });
  // No origin workspace => fallback separate run workspace.
  const executor = new HerdrStepExecutor({
    originFocus: {},
    client,
    cwd: root,
    closeWorkspaceOnDispose: true,
  });

  try {
    await executor.runAgentStep(
      {
        contract: baseContract(artifactDir, resultPath),
        prompt: "do work",
        spawn: { name: "worker", tools: "read", fork: false },
        accept: async (output) => ({ ok: true, value: output }),
      },
      new AbortController().signal,
    );
    await executor.dispose();

    const close = calls.find((args) => args[0] === "workspace" && args[1] === "close");
    assert.deepEqual(close, ["workspace", "close", "w-run"]);
    assert.equal(
      calls.some((args) => args[0] === "tab" && args[1] === "create"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
