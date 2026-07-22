/**
 * pi-herdr-workflows extension entry.
 *
 * Owns:
 * - `herdr` tool (forked from pi-herdr; old package should be disabled)
 * - `/workflow` command (graph engine + HerdrStepExecutor)
 *
 * Agent steps block on workflow_done (result.json). Results are written into
 * the session via sendMessage so they survive /reload (ui.notify does not).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import {
  WorkflowEngine,
  discoverWorkflows,
  loadWorkflowFile,
  resolveWorkflowRef,
  type WorkflowRunState,
  type WorkflowTraceEvent,
} from "../workflows/index.js";
import { HerdrStepExecutor } from "../herdr/executor.js";
import registerHerdrTool from "../herdr/tool.js";

const RESULT_MESSAGE_TYPE = "pi-herdr-workflows-result";

export default function (pi: ExtensionAPI) {
  // Forked pi-herdr tool. Registers only when HERDR_ENV is set.
  registerHerdrTool(pi);

  let engine: WorkflowEngine | null = null;
  let executor: HerdrStepExecutor | null = null;
  let running = false;

  function ensureEngine(
    notify: (message: string, level?: "info" | "warning" | "error") => void,
    onEvent: (event: WorkflowTraceEvent, state: WorkflowRunState) => void,
  ): WorkflowEngine {
    if (engine) return engine;
    executor = new HerdrStepExecutor({
      cwd: process.cwd(),
      // Leave agent panes alone mid-run; close the whole workspace after /workflow.
      closeWorkspaceOnDispose: true,
      onProgress: (event) => {
        notify(event.message, "info");
      },
    });
    engine = new WorkflowEngine({ executor, onEvent });
    return engine;
  }

  pi.registerCommand("workflow", {
    description:
      "Run a pi-herdr-workflows graph. Agent nodes dispatch to Herdr panes; local nodes run here.",
    async handler(args, ctx) {
      const raw = (args ?? "").trim();
      const search = { cwd: process.cwd() };

      if (!raw || raw === "list") {
        const found = await discoverWorkflows(search);
        if (found.length === 0) {
          ctx.ui.notify("No workflows found in .pi/workflows or ~/.pi/agent/workflows", "info");
          return;
        }
        const lines = found.map((w) => `- ${w.name}  (${w.path})`).join("\n");
        ctx.ui.notify(`Workflows:\n${lines}`, "info");
        return;
      }

      if (raw === "cancel") {
        engine?.cancel();
        ctx.ui.notify("Cancel requested", "info");
        return;
      }
      if (raw === "pause") {
        engine?.pause();
        ctx.ui.notify("Pause requested (after current step)", "info");
        return;
      }
      if (raw === "resume") {
        engine?.resume();
        ctx.ui.notify("Resume requested", "info");
        return;
      }

      if (running) {
        ctx.ui.notify("A workflow is already running", "error");
        return;
      }

      // `/workflow <name> [task...]` or `/workflow <name> --input-json {...}`
      const inputJsonMatch = raw.match(/^(.*?)\s+--input-json\s+([\s\S]+)$/);
      let namePart: string;
      let input: unknown;
      if (inputJsonMatch) {
        namePart = inputJsonMatch[1].trim();
        try {
          input = JSON.parse(inputJsonMatch[2]);
        } catch (error) {
          ctx.ui.notify(`Invalid --input-json: ${error}`, "error");
          return;
        }
      } else {
        const space = raw.indexOf(" ");
        namePart = space === -1 ? raw : raw.slice(0, space);
        const rest = space === -1 ? "" : raw.slice(space + 1).trim();
        input = rest ? { task: rest } : {};
      }

      const reserved = new Set(["cancel", "list", "pause", "resume"]);
      if (reserved.has(namePart)) {
        ctx.ui.notify(`${namePart} is reserved`, "error");
        return;
      }

      let workflowPath: string;
      try {
        const resolved = await resolveWorkflowRef(namePart, search);
        workflowPath = resolved.path;
      } catch (error) {
        ctx.ui.notify(String(error), "error");
        return;
      }

      let workflow;
      try {
        workflow = await loadWorkflowFile(workflowPath);
      } catch (error) {
        ctx.ui.notify(`Failed to load ${workflowPath}: ${error}`, "error");
        return;
      }

      running = true;
      ctx.ui.notify(
        `Starting workflow ${workflow.name} (blocks on workflow_done per agent step)`,
        "info",
      );

      try {
        const eng = ensureEngine(
          (message, level) => ctx.ui.notify(message, level),
          (event, state) => surfaceEvent(pi, event, state),
        );
        const result = await eng.run(workflow, input, {
          workflowPath: path.resolve(workflowPath),
        });
        surfaceFinal(pi, workflow.name, result.state, result.runDir);
      } catch (error) {
        pi.sendMessage(
          {
            customType: RESULT_MESSAGE_TYPE,
            content: `Workflow failed: ${error}`,
            display: true,
            details: { kind: "failed" },
          },
          { triggerTurn: false },
        );
        ctx.ui.notify(`Workflow failed: ${error}`, "error");
      } finally {
        running = false;
        // Tear down the per-run workspace so the next /workflow starts clean.
        try {
          await executor?.dispose();
        } catch {
          // Best effort.
        }
        executor = null;
        engine = null;
      }
    },
  });
}

function surfaceEvent(
  pi: ExtensionAPI,
  event: WorkflowTraceEvent,
  state: WorkflowRunState,
): void {
  switch (event.type) {
    case "node_finished": {
      const out = state.outputs[event.nodeId!];
      pi.sendMessage(
        {
          customType: RESULT_MESSAGE_TYPE,
          content: formatStepResult(event.nodeId!, out),
          display: true,
          details: {
            kind: "step",
            runId: state.runId,
            nodeId: event.nodeId,
            output: out,
          },
        },
        { triggerTurn: false },
      );
      return;
    }
    case "node_failed":
      pi.sendMessage(
        {
          customType: RESULT_MESSAGE_TYPE,
          content: `Step ${event.nodeId} failed: ${String(event.payload?.error ?? "unknown")}`,
          display: true,
          details: {
            kind: "step_failed",
            runId: state.runId,
            nodeId: event.nodeId,
            error: event.payload?.error,
          },
        },
        { triggerTurn: false },
      );
      return;
    default:
      return;
  }
}

function surfaceFinal(
  pi: ExtensionAPI,
  name: string,
  state: WorkflowRunState,
  runDir: string,
): void {
  if (state.status !== "completed") {
    pi.sendMessage(
      {
        customType: RESULT_MESSAGE_TYPE,
        content:
          `Workflow ${name} ${state.status}` +
          (state.error ? `: ${state.error}` : "") +
          `\nrunDir: ${runDir}`,
        display: true,
        details: {
          kind: "final",
          status: state.status,
          runId: state.runId,
          error: state.error,
          runDir,
        },
      },
      { triggerTurn: false },
    );
    return;
  }

  const body =
    state.finalOutput !== undefined
      ? JSON.stringify(state.finalOutput, null, 2)
      : JSON.stringify(state.outputs, null, 2);

  pi.sendMessage(
    {
      customType: RESULT_MESSAGE_TYPE,
      content: [
        `Workflow ${name} completed`,
        "",
        "Outputs:",
        JSON.stringify(state.outputs, null, 2),
        "",
        state.finalOutput !== undefined ? `Final:\n${body}` : "",
        "",
        `runDir: ${runDir}`,
      ]
        .filter((line) => line !== undefined)
        .join("\n")
        .trim(),
      display: true,
      details: {
        kind: "final",
        status: "completed",
        runId: state.runId,
        outputs: state.outputs,
        finalOutput: state.finalOutput,
        runDir,
      },
    },
    { triggerTurn: false },
  );
}

function formatStepResult(nodeId: string, output: unknown): string {
  let body: string;
  try {
    body = JSON.stringify(output, null, 2);
  } catch {
    body = String(output);
  }
  return `Step ${nodeId} done (workflow_done)\n${body}`;
}
