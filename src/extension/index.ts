import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import path from "node:path";
import { Type } from "typebox";
import {
  WorkflowEngine,
  discoverWorkflows,
  loadWorkflowFile,
  resolveWorkflowRef,
  type WorkflowDefinition,
  type WorkflowRunState,
  type WorkflowTraceEvent,
} from "../workflows/index.js";
import { HerdrStepExecutor, type HerdrAgentWaitProgress } from "../herdr/executor.js";
import registerHerdrTool from "../herdr/tool.js";

type WorkflowToolDetails = {
  phase: "starting" | "running" | "completed" | "waiting" | "failed";
  workflowName: string;
  message: string;
  elapsedMs: number;
  nodeId?: string;
  agentName?: string;
  paneId?: string;
  completedSteps?: number;
  status?: WorkflowRunState["status"];
  runId?: string;
  runDir?: string;
  outputs?: Record<string, unknown>;
  finalOutput?: unknown;
  presentationPrompt?: string;
};

export default function (pi: ExtensionAPI) {
  registerHerdrTool(pi);

  let activeEngine: WorkflowEngine | null = null;
  let activeExecutor: HerdrStepExecutor | null = null;
  let running = false;

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Run one deterministic pi-herdr-workflows definition. The tool follows the workflow graph, starts each agent node with Herdr 0.7.5's live-agent facade, waits for lifecycle signals, and streams progress until the run settles.",
    promptSnippet: "Run a deterministic workflow through Herdr agents and wait for completion",
    promptGuidelines: [
      "Use the workflow tool exactly once when a /workflow request asks you to run a named workflow; do not manually execute its nodes.",
      "Wait for the workflow tool result, then present the returned final output using any presentation instructions it includes.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Discovered workflow name or workflow file path" }),
      input: Type.Optional(Type.Unknown({ description: "JSON input passed to the workflow" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
        throw new Error("Workflow agent nodes require pi to run inside Herdr (HERDR_ENV=1).");
      }
      if (running) throw new Error("A workflow is already running.");

      const resolved = await resolveWorkflowRef(params.name, { cwd: ctx.cwd });
      const workflow = await loadWorkflowFile(resolved.path);
      const runSignal = signal ?? new AbortController().signal;
      const startedAt = Date.now();
      let latest: WorkflowToolDetails = {
        phase: "starting",
        workflowName: workflow.name,
        message: `Loading ${path.resolve(resolved.path)}`,
        elapsedMs: 0,
      };

      const publish = (patch: Partial<WorkflowToolDetails>) => {
        latest = { ...latest, ...patch, elapsedMs: Date.now() - startedAt };
        onUpdate?.({
          content: [{ type: "text", text: formatProgress(latest) }],
          details: latest,
        });
      };
      const onTrace = (event: WorkflowTraceEvent, state: WorkflowRunState) => {
        publish(traceProgress(event, state));
      };
      const onAgentProgress = (event: HerdrAgentWaitProgress) => {
        publish({
          phase: "running",
          nodeId: event.nodeId,
          agentName: event.agentName,
          paneId: event.paneId,
          message: event.message,
        });
      };

      activeExecutor = new HerdrStepExecutor({
        cwd: ctx.cwd,
        closeWorkspaceOnDispose: true,
        onProgress: onAgentProgress,
      });
      activeEngine = new WorkflowEngine({ executor: activeExecutor, onEvent: onTrace });
      running = true;
      const onAbort = () => activeEngine?.cancel();
      runSignal.addEventListener("abort", onAbort, { once: true });
      const ticker = onUpdate
        ? setInterval(() => publish({ message: latest.message }), 1_000)
        : undefined;

      try {
        publish({ phase: "running", message: `Starting workflow ${workflow.name}` });
        const result = await activeEngine.run(workflow, params.input ?? null, {
          workflowPath: path.resolve(resolved.path),
        });
        const presentationPrompt = await resolvePresentationPrompt(workflow, result.state, runSignal);
        const finalDetails: WorkflowToolDetails = {
          ...latest,
          phase: result.state.status === "completed" ? "completed" : result.state.status === "waiting" ? "waiting" : "failed",
          status: result.state.status,
          runId: result.state.runId,
          runDir: result.runDir,
          outputs: result.state.outputs,
          finalOutput: result.state.finalOutput,
          ...(presentationPrompt ? { presentationPrompt } : {}),
          message: `Workflow ${workflow.name} ${result.state.status}`,
          elapsedMs: Date.now() - startedAt,
          completedSteps: result.state.steps.length,
        };
        if (result.state.status === "failed" || result.state.status === "timed_out" || result.state.status === "cancelled") {
          throw new Error(
            `${finalDetails.message}${result.state.error ? `: ${result.state.error}` : ""}\nrunDir: ${result.runDir}`,
          );
        }
        return {
          content: [{ type: "text", text: formatFinalResult(finalDetails) }],
          details: finalDetails,
        };
      } finally {
        if (ticker) clearInterval(ticker);
        runSignal.removeEventListener("abort", onAbort);
        running = false;
        try {
          await activeExecutor?.dispose();
        } finally {
          activeExecutor = null;
          activeEngine = null;
        }
      }
    },

    renderCall(args, theme, context) {
      const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      component.setText(
        theme.fg("toolTitle", theme.bold("workflow ")) +
          theme.fg("accent", args.name || "?"),
      );
      return component;
    },

    renderResult(result, { isPartial, expanded }, theme) {
      const details = result.details as WorkflowToolDetails | undefined;
      if (!details) {
        const content = result.content?.[0];
        return new Text(content?.type === "text" ? content.text : "", 0, 0);
      }
      if (isPartial) {
        const node = details.nodeId ? ` · ${details.nodeId}` : "";
        return new Text(
          theme.fg(details.phase === "failed" ? "error" : "warning", "◌ ") +
            theme.fg("accent", details.workflowName) +
            theme.fg("dim", `${node} · ${formatElapsed(details.elapsedMs)}\n${details.message}`),
          0,
          0,
        );
      }
      let text = theme.fg(details.phase === "completed" ? "success" : "warning", "✓ ") +
        theme.fg("accent", details.workflowName) +
        theme.fg("dim", ` · ${details.status ?? details.phase} · ${formatElapsed(details.elapsedMs)}`);
      if (expanded && details.runDir) text += `\n${theme.fg("dim", details.runDir)}`;
      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("workflow", {
    description: "Ask the orchestrator to run a deterministic workflow through Herdr agents.",
    async handler(args, ctx) {
      const raw = (args ?? "").trim();
      if (!raw || raw === "list") {
        const found = await discoverWorkflows({ cwd: ctx.cwd });
        ctx.ui.notify(
          found.length
            ? `Workflows:\n${found.map((item) => `- ${item.name}  (${item.path})`).join("\n")}`
            : "No workflows found in .pi/workflows or ~/.pi/agent/workflows",
          "info",
        );
        return;
      }
      if (raw === "cancel") {
        activeEngine?.cancel();
        ctx.ui.notify(activeEngine ? "Cancel requested" : "No workflow is running", "info");
        return;
      }
      if (raw === "pause") {
        activeEngine?.pause();
        ctx.ui.notify(activeEngine ? "Pause requested after current step" : "No workflow is running", "info");
        return;
      }
      if (raw === "resume") {
        activeEngine?.resume();
        ctx.ui.notify(activeEngine ? "Resume requested" : "No workflow is running", "info");
        return;
      }
      if (running) {
        ctx.ui.notify("A workflow is already running", "error");
        return;
      }

      let invocation: { name: string; input: unknown };
      try {
        invocation = parseInvocation(raw);
        await resolveWorkflowRef(invocation.name, { cwd: ctx.cwd });
      } catch (error) {
        ctx.ui.notify(String(error), "error");
        return;
      }

      pi.sendUserMessage([
        {
          type: "text",
          text: [
            `Run the deterministic workflow ${JSON.stringify(invocation.name)} now.`,
            "Call the `workflow` tool exactly once with these arguments:",
            JSON.stringify(invocation),
            "The tool itself follows the workflow file, dispatches Herdr agents, waits for their lifecycle signals, and streams progress. Do not execute workflow nodes manually. After it returns, present the result.",
          ].join("\n"),
        },
      ]);
    },
  });
}

function parseInvocation(raw: string): { name: string; input: unknown } {
  const match = raw.match(/^(.*?)\s+--input-json\s+([\s\S]+)$/);
  if (match) {
    return { name: match[1]!.trim(), input: JSON.parse(match[2]!) };
  }
  const space = raw.indexOf(" ");
  const name = space === -1 ? raw : raw.slice(0, space);
  const task = space === -1 ? "" : raw.slice(space + 1).trim();
  return { name, input: task ? { task } : {} };
}

function traceProgress(
  event: WorkflowTraceEvent,
  state: WorkflowRunState,
): Partial<WorkflowToolDetails> {
  switch (event.type) {
    case "node_started":
      return {
        phase: "running",
        nodeId: event.nodeId,
        message: `Starting ${event.payload.nodeType} node ${event.nodeId}`,
        completedSteps: state.steps.length,
      };
    case "node_finished":
      return {
        phase: "running",
        nodeId: event.nodeId,
        message: `Finished node ${event.nodeId}`,
        completedSteps: state.steps.length,
      };
    case "node_failed":
      return {
        phase: "failed",
        nodeId: event.nodeId,
        message: `Node ${event.nodeId} failed: ${String(event.payload.error ?? "unknown")}`,
        completedSteps: state.steps.length,
      };
    case "run_paused":
      return { phase: "waiting", message: "Workflow paused at a step boundary" };
    case "run_resumed":
      return { phase: "running", message: "Workflow resumed" };
    default:
      return { completedSteps: state.steps.length };
  }
}

async function resolvePresentationPrompt(
  workflow: WorkflowDefinition,
  state: WorkflowRunState,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (typeof workflow.presentationPrompt === "string") return workflow.presentationPrompt;
  return await workflow.presentationPrompt?.({
    state,
    finalOutput: state.finalOutput,
    signal,
  });
}

function formatProgress(details: WorkflowToolDetails): string {
  const node = details.nodeId ? ` · node ${details.nodeId}` : "";
  return `${details.workflowName}${node} · ${formatElapsed(details.elapsedMs)}\n${details.message}`;
}

function formatFinalResult(details: WorkflowToolDetails): string {
  const body = [
    `Workflow ${details.workflowName} ${details.status}`,
    details.presentationPrompt ? `Presentation instructions: ${details.presentationPrompt}` : undefined,
    "",
    "Final output:",
    JSON.stringify(details.finalOutput ?? details.outputs ?? null, null, 2),
    "",
    `runDir: ${details.runDir}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  const truncated = truncateHead(body, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  return truncated.truncated
    ? `${truncated.content}\n\n[Output truncated; full state is in ${details.runDir}/state.json]`
    : truncated.content;
}

function formatElapsed(elapsedMs: number): string {
  return `${Math.floor(elapsedMs / 1_000)}s`;
}
