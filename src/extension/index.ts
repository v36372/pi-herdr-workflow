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
import {
  buildNodeProgress,
  formatProgressText,
  formatProgressThemed,
  PI_DEFAULT_SPINNER_FRAMES,
  type WorkflowProgressSnapshot,
} from "./progress.js";

const WORKFLOW_WIDGET_KEY = "pi-herdr-workflows";

type WorkflowToolDetails = WorkflowProgressSnapshot & {
  completedSteps?: number;
  runId?: string;
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
      let latestState: WorkflowRunState | undefined;
      let latest: WorkflowToolDetails = {
        phase: "starting",
        workflowName: workflow.name,
        message: `Loading ${path.resolve(resolved.path)}`,
        elapsedMs: 0,
        nodes: buildNodeProgress({ workflow, phase: "starting" }),
      };

      let spinnerFrame = 0;
      const publish = (patch: Partial<WorkflowToolDetails>, options?: { advanceSpinner?: boolean }) => {
        if (options?.advanceSpinner) {
          spinnerFrame = (spinnerFrame + 1) % PI_DEFAULT_SPINNER_FRAMES.length;
        }
        latest = {
          ...latest,
          ...patch,
          elapsedMs: Date.now() - startedAt,
          spinnerFrame,
          nodes:
            patch.nodes ??
            buildNodeProgress({
              workflow,
              state: latestState,
              currentNodeId: patch.currentNodeId ?? latest.currentNodeId,
              phase: patch.phase ?? latest.phase,
            }),
        };
        // Live step checklist lives in the tool call partial (not a sticky widget).
        onUpdate?.({
          content: [{ type: "text", text: formatProgressText(latest) }],
          details: latest,
        });
      };
      const onTrace = (event: WorkflowTraceEvent, state: WorkflowRunState) => {
        latestState = state;
        publish(traceProgress(event, state, workflow));
      };
      const onAgentProgress = (event: HerdrAgentWaitProgress) => {
        // Keep pane/agent ids for details, but don't surface raw herdr CLI text.
        // The one-liner comes from the node's statusDetail (or spawn.name).
        const activity =
          event.phase === "blocked"
            ? "waiting for input"
            : event.phase === "validation_retry"
              ? "retrying invalid output"
              : undefined;
        publish({
          phase: "running",
          currentNodeId: event.nodeId,
          currentNodeType: "agent",
          agentName: event.agentName,
          paneId: event.paneId,
          ...(activity ? { activity, message: activity } : {}),
        });
      };

      activeExecutor = new HerdrStepExecutor({
        cwd: ctx.cwd,
        // Capture the orchestrator location before any agent step can steal focus.
        // Closing the run workspace without restoring first can land Herdr on an
        // unrelated empty workspace.
        originFocus: {
          ...(process.env.HERDR_WORKSPACE_ID
            ? { workspaceId: process.env.HERDR_WORKSPACE_ID }
            : {}),
          ...(process.env.HERDR_TAB_ID ? { tabId: process.env.HERDR_TAB_ID } : {}),
        },
        closeWorkspaceOnDispose: true,
        onProgress: onAgentProgress,
      });
      activeEngine = new WorkflowEngine({ executor: activeExecutor, onEvent: onTrace });
      running = true;
      const onAbort = () => activeEngine?.cancel();
      runSignal.addEventListener("abort", onAbort, { once: true });
      // Tick elapsed time + braille spinner on the in-chat tool partial.
      // Spinner advances on a faster cadence (Pi Loader default ~80–120ms feel),
      // elapsed still updates every tick via Date.now().
      const ticker = onUpdate
        ? setInterval(() => publish({}, { advanceSpinner: true }), 120)
        : undefined;

      try {
        publish({
          phase: "running",
          message: `Starting workflow ${workflow.name}`,
        });
        const result = await activeEngine.run(workflow, params.input ?? null, {
          workflowPath: path.resolve(resolved.path),
        });
        latestState = result.state;
        const presentationPrompt = await resolvePresentationPrompt(workflow, result.state, runSignal);
        const phase =
          result.state.status === "completed"
            ? "completed"
            : result.state.status === "waiting"
              ? "waiting"
              : "failed";
        const finalDetails: WorkflowToolDetails = {
          ...latest,
          phase,
          status: result.state.status,
          runId: result.state.runId,
          runDir: result.runDir,
          outputs: result.state.outputs,
          finalOutput: result.state.finalOutput,
          ...(presentationPrompt ? { presentationPrompt } : {}),
          message: `Workflow ${workflow.name} ${result.state.status}`,
          elapsedMs: Date.now() - startedAt,
          completedSteps: result.state.steps.length,
          currentNodeId: result.state.currentNode ?? result.state.waitingOn,
          nodes: buildNodeProgress({
            workflow,
            state: result.state,
            phase,
          }),
        };
        latest = finalDetails;
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
        if (ctx.hasUI) {
          // Clear any leftover sticky widget from older package versions.
          ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, undefined);
        }
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

    renderResult(result, { isPartial, expanded }, theme, context) {
      const details = result.details as WorkflowToolDetails | undefined;
      const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (!details) {
        const content = result.content?.[0];
        component.setText(content?.type === "text" ? content.text : "");
        return component;
      }
      // Partial and settled both show the step checklist inside the tool result.
      let text = formatProgressThemed(details, theme);
      if (!isPartial && expanded && details.runDir) {
        text += `\n${theme.fg("dim", details.runDir)}`;
      }
      component.setText(text);
      return component;
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
  workflow: WorkflowDefinition,
): Partial<WorkflowToolDetails> {
  const base = {
    completedSteps: state.steps.length,
    currentNodeId: state.currentNode ?? state.waitingOn,
    status: state.status,
    nodes: buildNodeProgress({
      workflow,
      state,
      phase:
        event.type === "node_failed"
          ? "failed"
          : state.status === "waiting"
            ? "waiting"
            : "running",
    }),
  } satisfies Partial<WorkflowToolDetails>;

  switch (event.type) {
    case "node_started": {
      const nodeId = event.nodeId ?? "";
      const node = workflow.nodes[nodeId];
      const detail =
        (typeof node?.statusDetail === "string" && node.statusDetail.trim()) ||
        (node?.nodeType === "agent" && typeof node.spawn?.name === "string"
          ? node.spawn.name
          : undefined) ||
        `Running ${nodeId}`;
      return {
        ...base,
        phase: "running",
        currentNodeId: nodeId || undefined,
        currentNodeType: node?.nodeType,
        activity: detail,
        message: detail,
      };
    }
    case "node_finished":
      return {
        ...base,
        phase: "running",
        // Keep last activity until the next node_started overwrites it.
        currentNodeType: undefined,
      };
    case "node_failed":
      return {
        ...base,
        phase: "failed",
        activity: `Failed: ${String(event.payload.error ?? "unknown")}`,
        message: `Failed: ${String(event.payload.error ?? "unknown")}`,
      };
    case "run_paused":
      return {
        ...base,
        phase: "waiting",
        activity: "Workflow paused at a step boundary",
        message: "Workflow paused at a step boundary",
      };
    case "run_resumed":
      return {
        ...base,
        phase: "running",
        activity: "Workflow resumed",
        message: "Workflow resumed",
      };
    default:
      return base;
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

function formatFinalResult(details: WorkflowToolDetails): string {
  const body = [
    `Workflow ${details.workflowName} ${details.status}`,
    details.presentationPrompt ? `Presentation instructions: ${details.presentationPrompt}` : undefined,
    "",
    formatProgressText(details),
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
