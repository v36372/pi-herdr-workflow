import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PI = path.join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = path.join(ROOT, "src", "extension", "index.ts");
const STUB = path.join(ROOT, "scripts", "workflow-stub-model.ts");

async function runPi(args: {
  prompt: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ code: number | null; stdout: string; stderr: string; output: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${path.join(ROOT, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
    PI_BIN: PI,
    ...args.env,
  };
  return await new Promise((resolve, reject) => {
    const child = spawn(
      PI,
      [
        "--no-session",
        "-ne",
        "-e",
        EXTENSION,
        "-a",
        "--offline",
        "-p",
        args.prompt,
      ],
      { cwd: args.cwd ?? ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`pi timed out for ${args.prompt}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, args.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
  });
}

test("pi --extension loads /workflow list", { timeout: 30_000 }, async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "phw-pi-list-"));
  try {
    mkdirSync(path.join(cwd, ".pi", "workflows"), { recursive: true });
    copyFileSync(
      path.join(ROOT, "examples", "hello.workflow.ts"),
      path.join(cwd, ".pi", "workflows", "hello.workflow.ts"),
    );
    const result = await runPi({ prompt: "/workflow list", cwd });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /pi-herdr-workflows launch/);
    assert.match(result.output, /hello/);
    assert.match(result.output, /src\/extension\/index\.ts/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("pi --extension runs compute and shell example workflows", { timeout: 60_000 }, async () => {
  const hello = await runPi({
    prompt: `/workflow ${path.join("examples", "hello.workflow.ts")} --input-json {"name":"tin"}`,
  });
  assert.equal(hello.code, 0, hello.output);
  assert.match(hello.output, /Workflow hello completed/);
  assert.match(hello.output, /hello, tin/);

  const pipeline = await runPi({
    prompt: `/workflow ${path.join("examples", "demo", "01-compute-pipeline.workflow.ts")} --input-json {"value":"Pi-Herdr"}`,
  });
  assert.equal(pipeline.code, 0, pipeline.output);
  assert.match(pipeline.output, /Workflow 01-compute-pipeline completed/);
  assert.match(pipeline.output, /pi-herdr/);

  const facts = await runPi({
    prompt: `/workflow ${path.join("examples", "demo", "02-shell-facts.workflow.ts")} --input-json {"label":"build"}`,
  });
  assert.equal(facts.code, 0, facts.output);
  assert.match(facts.output, /Workflow 02-shell-facts completed/);
  assert.match(facts.output, /shell-ok/);

  const timeout = await runPi({
    prompt: `/workflow ${path.join("examples", "demo", "03-timeout-budget.workflow.ts")} --input-json {"budgetMs":2000,"tag":"fast"}`,
  });
  assert.equal(timeout.code, 0, timeout.output);
  assert.match(timeout.output, /Workflow 03-timeout-budget completed/);

  const rejoin = await runPi({
    prompt: `/workflow ${path.join("examples", "demo", "05-decision-rejoin.workflow.ts")} --input-json {"route":"right"}`,
  });
  assert.equal(rejoin.code, 0, rejoin.output);
  assert.match(rejoin.output, /took right path/);

  const repair = await runPi({
    prompt: `/workflow ${path.join("examples", "demo", "07-repair-outcome.workflow.ts")} --input-json {"mode":"fail"}`,
  });
  assert.equal(repair.code, 0, repair.output);
  assert.match(repair.output, /"status": "repaired"/);
});

test("pi --extension spawn interface runs agent example workflows via stub model", { timeout: 180_000 }, async () => {
  const stubEnv = {
    PI_WORKFLOW_STUB_EXTENSION: STUB,
    PI_WORKFLOW_STUB_MODEL: "workflow-stub/echo",
  };

  const matrix = await runPi({
    prompt: `/workflow ${path.join("examples", "demo", "04-spawn-matrix.workflow.ts")} --input-json {"echo":"ping"}`,
    env: stubEnv,
    timeoutMs: 90_000,
  });
  assert.equal(matrix.code, 0, matrix.output);
  assert.match(matrix.output, /Workflow 04-spawn-matrix completed/);
  assert.match(matrix.output, /"echo": "ping"/);

  const echo = await runPi({
    prompt: `/workflow ${path.join("examples", "echo.workflow.ts")} say hello in one sentence`,
    env: stubEnv,
    timeoutMs: 90_000,
  });
  assert.equal(echo.code, 0, echo.output);
  assert.match(echo.output, /Workflow echo completed/);
  assert.match(echo.output, /"reply":/);

  const relay = await runPi({
    prompt: `/workflow ${path.join("examples", "relay.workflow.ts")} ocean`,
    env: stubEnv,
    timeoutMs: 120_000,
  });
  assert.equal(relay.code, 0, relay.output);
  assert.match(relay.output, /Workflow relay completed/);
  assert.match(relay.output, /"shout": "OCEAN"/);
});
