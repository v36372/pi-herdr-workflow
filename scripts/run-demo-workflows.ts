import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  WorkflowEngine,
  loadWorkflowFile,
  workflowFileStem,
  type AgentStepExecutor,
  type AgentStepRequest,
  type AgentStepSubmission,
  type WorkflowDefinition,
} from "../src/index.ts";
import { writeFakeAgentResult } from "../src/herdr/executor.ts";

const DEMO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "demo");

/**
 * Hermetic agent executor for graded demos. Writes result.json, guesses a
 * plausible output from prompt/contract heuristics, accepts via the engine,
 * and retries once with a richer object when validation rejects.
 */
export class DemoAgentExecutor implements AgentStepExecutor {
  lastRequest: AgentStepRequest | null = null;
  requests: AgentStepRequest[] = [];
  hangUntilAbort = false;

  async runAgentStep(
    request: AgentStepRequest,
    signal: AbortSignal,
  ): Promise<AgentStepSubmission> {
    this.lastRequest = request;
    this.requests.push(request);

    if (this.hangUntilAbort) {
      await hangUntilSignal(signal);
    }

    let output = guessDemoOutput(request);
    writeFakeAgentResult({
      resultPath: request.contract.resultPath,
      runId: request.contract.runId,
      nodeId: request.contract.nodeId,
      attemptId: request.contract.attemptId,
      output,
    });
    let accepted = await request.accept(output);
    if (!accepted.ok) {
      output = richerDemoOutput(request, accepted.error);
      writeFakeAgentResult({
        resultPath: request.contract.resultPath,
        runId: request.contract.runId,
        nodeId: request.contract.nodeId,
        attemptId: request.contract.attemptId,
        output,
      });
      accepted = await request.accept(output);
      if (!accepted.ok) {
        throw new Error(accepted.error);
      }
    }
    return { output: accepted.value };
  }
}

export async function hangUntilSignal(signal: AbortSignal): Promise<never> {
  return await new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function guessDemoOutput(request: AgentStepRequest): unknown {
  const quoted = request.prompt.match(
    /Echo (?:seed |this exact string in the echo field: )"([^"]+)"/,
  );
  if (quoted) {
    return { echo: quoted[1] };
  }

  const fromExpected = guessFromExpected(request.contract.expectedOutput);
  if (fromExpected !== null) {
    return fromExpected;
  }

  return { echo: "demo" };
}

export function richerDemoOutput(request: AgentStepRequest, _previousError: string): unknown {
  const fromExpected = guessFromExpected(request.contract.expectedOutput, { rich: true });
  if (fromExpected !== null) {
    return fromExpected;
  }
  return { echo: "demo" };
}

function guessFromExpected(
  expected: string | undefined,
  options: { rich?: boolean } = {},
): Record<string, unknown> | null {
  if (!expected) return null;
  const keys = [...expected.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)].map((match) => match[1]!);
  if (keys.length === 0) return null;

  const out: Record<string, unknown> = {};
  for (const key of keys) {
    switch (key) {
      case "steps":
        out[key] = [{ id: "1", title: "demo step", owner: "agent" }];
        break;
      case "retry":
      case "ok":
        out[key] = true;
        break;
      default:
        out[key] = key === "diagnosis" ? "probe failed on purpose" : "demo";
        break;
    }
  }
  if (options.rich && !("echo" in out)) {
    out.echo = "demo";
  }
  return out;
}

export async function listDemoWorkflowFiles(demoDir = DEMO_DIR): Promise<string[]> {
  const entries = await fs.readdir(demoDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".workflow.ts"))
    .map((entry) => path.join(demoDir, entry.name))
    .sort();
}

export function defaultDemoInput(workflowName: string): unknown {
  if (workflowName.includes("compute-pipeline")) return { value: "demo" };
  if (workflowName.includes("shell-facts")) return { label: "demo" };
  if (workflowName.includes("timeout-budget")) return { budgetMs: 2_000, tag: "fast" };
  if (workflowName.includes("spawn-matrix")) return { echo: "ping" };
  if (workflowName.includes("decision-rejoin")) return { route: "left" };
  if (workflowName.includes("checkpoint-continue")) return { topic: "demo work" };
  if (workflowName.includes("repair-outcome")) return { mode: "ok" };
  if (workflowName.includes("parkable-stages")) return { seed: "alpha" };
  return {};
}

export async function runDemoWorkflow(args: {
  workflow: WorkflowDefinition;
  workflowPath?: string;
  input?: unknown;
  outputRoot: string;
  executor?: DemoAgentExecutor;
  continueInput?: unknown;
}): Promise<{
  status: string;
  finalOutput: unknown;
  runId: string;
  continuedStatus?: string;
  continuedFinalOutput?: unknown;
  executor: DemoAgentExecutor;
}> {
  const executor = args.executor ?? new DemoAgentExecutor();
  const engine = new WorkflowEngine({
    executor,
    outputRoot: args.outputRoot,
    maxSteps: 50,
    defaultNodeTimeoutMs: 5_000,
  });
  const input = args.input ?? defaultDemoInput(args.workflow.name);
  const { state } = await engine.run(args.workflow, input, {
    ...(args.workflowPath !== undefined ? { workflowPath: args.workflowPath } : {}),
  });

  if (state.status === "waiting") {
    const continued = await engine.continueRun(
      args.workflow,
      state.runId,
      args.continueInput ?? { approved: true },
    );
    return {
      status: state.status,
      finalOutput: state.finalOutput,
      runId: state.runId,
      continuedStatus: continued.state.status,
      continuedFinalOutput: continued.state.finalOutput,
      executor,
    };
  }

  return {
    status: state.status,
    finalOutput: state.finalOutput,
    runId: state.runId,
    executor,
  };
}

async function main(): Promise<void> {
  const filter = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  const files = await listDemoWorkflowFiles();
  const selected = filter
    ? files.filter(
        (file) =>
          workflowFileStem(file).includes(filter) || path.basename(file).includes(filter),
      )
    : files;

  if (selected.length === 0) {
    console.error(`No demo workflows matched${filter ? ` filter ${JSON.stringify(filter)}` : ""}.`);
    process.exit(1);
  }

  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "phw-demo-"));
  console.log(`outputRoot=${outputRoot}`);
  let failed = 0;

  for (const file of selected) {
    const stem = workflowFileStem(file);
    const workflow = await loadWorkflowFile(file);
    const result = await runDemoWorkflow({
      workflow,
      workflowPath: file,
      outputRoot,
    });

    const terminalStatus = result.continuedStatus ?? result.status;
    const terminalOutput = result.continuedFinalOutput ?? result.finalOutput;
    const ok =
      terminalStatus === "completed" ||
      (result.status === "waiting" && result.continuedStatus === "completed");

    console.log(
      `\n[${stem}] status=${result.status}${result.continuedStatus ? ` → ${result.continuedStatus}` : ""}`,
    );
    console.log(JSON.stringify(terminalOutput, null, 2));

    if (!ok) {
      failed += 1;
      console.error(`[${stem}] FAILED with status ${terminalStatus}`);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} demo workflow(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${selected.length} demo workflow(s) completed`);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
