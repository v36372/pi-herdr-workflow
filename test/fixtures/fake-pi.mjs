#!/usr/bin/env node
/**
 * Stand-in for vanilla `pi` used by PiProcessExecutor unit tests.
 * Writes result.json from PI_WORKFLOW_* env unless told to skip.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const artifactDir = process.env.PI_WORKFLOW_ARTIFACT_DIR;
const resultPath = process.env.PI_WORKFLOW_RESULT_PATH;
if (!artifactDir || !resultPath) {
  console.error("fake-pi: missing PI_WORKFLOW_ARTIFACT_DIR or PI_WORKFLOW_RESULT_PATH");
  process.exit(2);
}

const callFile = path.join(artifactDir, "fake-pi-calls");
const callCount = existsSync(callFile) ? Number(readFileSync(callFile, "utf8")) + 1 : 1;
writeFileSync(callFile, String(callCount), "utf8");
writeFileSync(
  path.join(artifactDir, "fake-pi-argv.json"),
  `${JSON.stringify({ argv: process.argv, cwd: process.cwd(), callCount }, null, 2)}\n`,
  "utf8",
);

const sleepMs = Number(process.env.PI_FAKE_PI_SLEEP_MS ?? "0");
if (Number.isFinite(sleepMs) && sleepMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, sleepMs));
}

if (process.env.PI_FAKE_PI_SKIP_RESULT === "1") {
  process.exit(Number(process.env.PI_FAKE_PI_EXIT ?? "0"));
}

let output = { ok: true, echo: "pong" };
const scripted = process.env.PI_FAKE_PI_OUTPUT;
if (scripted) {
  output = JSON.parse(scripted);
} else if (process.env.PI_FAKE_PI_FAIL_FIRST === "1" && callCount === 1) {
  output = { score: "bad" };
} else if (process.env.PI_FAKE_PI_FAIL_FIRST === "1") {
  output = { score: 42 };
}

writeFileSync(
  resultPath,
  `${JSON.stringify(
    {
      schema: "pi-herdr-workflows.result.v1",
      runId: process.env.PI_WORKFLOW_RUN_ID,
      nodeId: process.env.PI_WORKFLOW_NODE_ID,
      attemptId: process.env.PI_WORKFLOW_ATTEMPT_ID,
      output,
      writtenAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.exit(Number(process.env.PI_FAKE_PI_EXIT ?? "0"));
