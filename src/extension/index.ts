import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  SettingsManager,
  truncateHead,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  WorkflowEngine,
  discoverWorkflows,
  loadWorkflowFile,
  resolveWorkflowRef,
  type DiscoveredWorkflow,
  type WorkflowDefinition,
  type WorkflowRunState,
  type WorkflowTraceEvent,
} from "../workflows/index.js";
import { HerdrStepExecutor, type HerdrAgentWaitProgress } from "../herdr/executor.js";
import { isInsideHerdr } from "../herdr/pi-args.js";
import { PiProcessExecutor } from "../herdr/pi-spawn.js";
import registerHerdrTool from "../herdr/tool.js";
import {
  applyModelOverrides,
  buildAgentModelMenuOptions,
  buildWorkflowLaunchPrompt,
  filterModelRefsByScope,
  formatModelRef,
  formatWorkflowOption,
  isDoneAgentModelsOption,
  isResetAgentModelsOption,
  listAgentSteps,
  modelInputHint,
  modelInputTitle,
  parseAgentStepOption,
  parseWorkflowOption,
  resolveModelInput,
  type WorkflowAgentStep,
  type WorkflowLaunchInvocation,
  type WorkflowModelOverrides,
} from "./launch.js";
import { AgentModelEditor, type AgentModelEditorResult } from "./model-editor.js";

/** Bump when launch UX changes so a stale /reload is obvious. */
const LAUNCH_UX_VERSION = "v4-vim";
const EXTENSION_FILE = fileURLToPath(import.meta.url);
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
  let activeExecutor: HerdrStepExecutor | PiProcessExecutor | null = null;
  let running = false;

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Run one deterministic pi-herdr-workflows definition. The tool follows the workflow graph, dispatches agent nodes through Herdr panes when inside Herdr or as standalone vanilla pi children otherwise, waits for workflow_done, and streams progress until the run settles.",
    promptSnippet: "Run a deterministic workflow through Herdr agents and wait for completion",
    promptGuidelines: [
      "Use the workflow tool exactly once when a /workflow request asks you to run a named workflow; do not manually execute its nodes.",
      "Wait for the workflow tool result, then present the returned final output using any presentation instructions it includes.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Discovered workflow name or workflow file path" }),
      input: Type.Optional(Type.Unknown({ description: "JSON input passed to the workflow" })),
      modelOverrides: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description:
            "Optional per-agent-node model overrides as provider/id (e.g. openai-codex/gpt-5.6-luna). Omitted nodes keep their workflow/agent defaults.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (running) throw new Error("A workflow is already running.");

      const resolved = await resolveWorkflowRef(params.name, { cwd: ctx.cwd });
      const loaded = await loadWorkflowFile(resolved.path);
      const workflow = applyModelOverrides(loaded, params.modelOverrides);
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
            : event.phase === "completion_retry"
              ? "retrying missing workflow_done"
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

      activeExecutor = createAgentExecutor(ctx, onAgentProgress);
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
    description: `Pick/run a workflow (${LAUNCH_UX_VERSION} agent-model overlay). Subcommands: list, pause, resume, cancel.`,
    async handler(args, ctx) {
      const raw = (args ?? "").trim();
      if (raw === "list") {
        const found = await discoverWorkflows({ cwd: ctx.cwd });
        const mtime = existsSync(EXTENSION_FILE)
          ? statSync(EXTENSION_FILE).mtime.toISOString()
          : "?";
        reportCommandOutput(
          ctx,
          [
            `pi-herdr-workflows launch ${LAUNCH_UX_VERSION}`,
            `extension: ${EXTENSION_FILE}`,
            `mtime: ${mtime}`,
            found.length
              ? `Workflows:\n${found.map((item) => `- ${item.name}  (${item.path})`).join("\n")}`
              : "No workflows found in .pi/workflows or ~/.pi/agent/workflows",
          ].join("\n"),
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

      let invocation: WorkflowLaunchInvocation | undefined;
      try {
        invocation = raw ? parseInvocation(raw) : await promptWorkflowLaunch(ctx);
        if (!invocation) return; // cancelled menu
        await resolveWorkflowRef(invocation.name, { cwd: ctx.cwd });
      } catch (error) {
        ctx.ui.notify(String(error), "error");
        return;
      }

      if (shouldRunWorkflowInCommand(ctx)) {
        running = true;
        try {
          const result = await executeWorkflowFromCommand(invocation, ctx);
          reportCommandOutput(ctx, result, "info");
        } catch (error) {
          reportCommandOutput(ctx, String(error), "error");
        } finally {
          running = false;
        }
        return;
      }

      pi.sendUserMessage([
        {
          type: "text",
          text: buildWorkflowLaunchPrompt(invocation),
        },
      ]);
    },
  });
}

/**
 * Interactive /workflow launcher: pick a discovered workflow, optionally set
 * agent models, optionally supply a task string, then return a tool invocation.
 */
async function promptWorkflowLaunch(
  ctx: ExtensionCommandContext,
): Promise<WorkflowLaunchInvocation | undefined> {
  if (!ctx.hasUI) {
    const found = await discoverWorkflows({ cwd: ctx.cwd });
    throw new Error(
      found.length
        ? `No UI available. Run /workflow <name> [task]. Available: ${found.map((item) => item.name).join(", ")}`
        : "No UI available and no workflows found.",
    );
  }

  const found = await discoverWorkflows({ cwd: ctx.cwd });
  if (found.length === 0) {
    ctx.ui.notify("No workflows found in .pi/workflows or ~/.pi/agent/workflows", "info");
    return undefined;
  }

  const selectedOption = await ctx.ui.select(
    "Select workflow",
    found.map((item) => formatWorkflowOption(item)),
  );
  if (!selectedOption) return undefined;

  const selected = findDiscoveredWorkflow(found, parseWorkflowOption(selectedOption));
  if (!selected) {
    throw new Error(`Unknown workflow selection: ${selectedOption}`);
  }

  const definition = await loadWorkflowFile(selected.path);
  // undefined = cancelled a model dialog; {} = keep authored defaults.
  const modelOverrides = await promptModelOverrides(ctx, definition);
  if (modelOverrides === undefined) return undefined;

  const task = await ctx.ui.input("Task / input (optional, Enter to skip)", "");
  if (task === undefined) return undefined;

  const invocation: WorkflowLaunchInvocation = {
    name: selected.name,
    input: task.trim() ? { task: task.trim() } : {},
  };
  if (Object.keys(modelOverrides).length > 0) {
    invocation.modelOverrides = modelOverrides;
  }
  return invocation;
}

/**
 * Floating agent-model editor (custom overlay).
 * Falls back to a select loop if custom/overlay is unavailable.
 * Returns `{}` for defaults, a map for overrides, or `undefined` on Esc cancel.
 */
async function promptModelOverrides(
  ctx: ExtensionCommandContext,
  workflow: WorkflowDefinition,
): Promise<WorkflowModelOverrides | undefined> {
  const settings = SettingsManager.create(ctx.cwd, undefined, {
    projectTrusted: ctx.isProjectTrusted(),
  });
  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  const piDefaultModel =
    defaultProvider && defaultModelId
      ? formatModelRef({ provider: defaultProvider, id: defaultModelId })
      : ctx.model
        ? formatModelRef(ctx.model)
        : undefined;
  const steps = listAgentSteps(workflow, piDefaultModel);
  if (steps.length === 0) return {};

  // Visible fingerprint so a stale session is obvious.
  ctx.ui.notify(
    `pi-herdr-workflows ${LAUNCH_UX_VERSION} · ${steps.length} agent step${steps.length === 1 ? "" : "s"} · ${path.basename(EXTENSION_FILE)}`,
    "info",
  );

  const modelSuggestions = filterModelRefsByScope(
    ctx.modelRegistry.getAvailable(),
    settings.getEnabledModels(),
  );

  try {
    const result = await ctx.ui.custom<AgentModelEditorResult>(
      (tui, theme, _keybindings, done) =>
        new AgentModelEditor({
          theme,
          workflowName: workflow.name,
          steps,
          modelSuggestions,
          done,
          requestRender: () => tui.requestRender(),
        }),
      { overlay: true },
    );
    if (!result || result.kind === "cancelled") return undefined;
    return result.overrides;
  } catch (error) {
    ctx.ui.notify(
      `Overlay model editor failed (${error instanceof Error ? error.message : String(error)}). Falling back to step list.`,
      "warning",
    );
    return await promptModelOverridesSelectFallback(ctx, workflow, steps);
  }
}

/** Select-based fallback if custom overlay cannot run. */
async function promptModelOverridesSelectFallback(
  ctx: ExtensionCommandContext,
  workflow: WorkflowDefinition,
  steps: WorkflowAgentStep[],
): Promise<WorkflowModelOverrides | undefined> {
  const stepsById = new Map(steps.map((step) => [step.nodeId, step]));
  const overrides: WorkflowModelOverrides = {};

  while (true) {
    const choice = await ctx.ui.select(
      `Agent models (${LAUNCH_UX_VERSION} fallback) · ${workflow.name}`,
      buildAgentModelMenuOptions(steps, overrides),
    );
    if (!choice) return undefined;
    if (isDoneAgentModelsOption(choice)) return overrides;
    if (isResetAgentModelsOption(choice)) {
      for (const key of Object.keys(overrides)) delete overrides[key];
      continue;
    }

    const step = stepsById.get(parseAgentStepOption(choice));
    if (!step) continue;

    const raw = await ctx.ui.input(modelInputTitle(step), modelInputHint(step));
    const resolved = resolveModelInput(raw, step.defaultModel);
    if (resolved.kind === "override") {
      overrides[step.nodeId] = resolved.model;
    } else {
      delete overrides[step.nodeId];
      if (resolved.kind === "invalid") {
        ctx.ui.notify(
          `Invalid model ${JSON.stringify(resolved.raw)}; kept default for ${step.nodeId}.`,
          "warning",
        );
      }
    }
  }
}

function findDiscoveredWorkflow(
  found: DiscoveredWorkflow[],
  name: string,
): DiscoveredWorkflow | undefined {
  return found.find((item) => item.name === name);
}

function parseInvocation(raw: string): { name: string; input: unknown; modelOverrides?: WorkflowModelOverrides } {
  const match = raw.match(/^(.*?)\s+--input-json\s+([\s\S]+)$/);
  if (match) {
    return { name: match[1]!.trim(), input: JSON.parse(match[2]!) };
  }
  const space = raw.indexOf(" ");
  const name = space === -1 ? raw : raw.slice(0, space);
  const task = space === -1 ? "" : raw.slice(space + 1).trim();
  return { name, input: task ? { task } : {} };
}

function shouldRunWorkflowInCommand(ctx: ExtensionCommandContext): boolean {
  if (ctx.mode === "print" || ctx.mode === "json") return true;
  return ctx.model == null;
}

function reportCommandOutput(
  ctx: ExtensionCommandContext,
  text: string,
  type: "info" | "warning" | "error",
): void {
  if (ctx.mode === "print") {
    if (type === "error") console.error(text);
    else console.log(text);
    return;
  }
  if (ctx.mode === "json") {
    console.error(text);
    return;
  }
  ctx.ui.notify(text, type);
}

function createAgentExecutor(
  ctx: ExtensionContext,
  onProgress: (event: HerdrAgentWaitProgress) => void,
): HerdrStepExecutor | PiProcessExecutor {
  if (isInsideHerdr()) {
    return new HerdrStepExecutor({
      cwd: ctx.cwd,
      originFocus: {
        ...(process.env.HERDR_WORKSPACE_ID
          ? { workspaceId: process.env.HERDR_WORKSPACE_ID }
          : {}),
        ...(process.env.HERDR_TAB_ID ? { tabId: process.env.HERDR_TAB_ID } : {}),
      },
      closeWorkspaceOnDispose: true,
      onProgress,
    });
  }

  const extraChildExtensions = (process.env.PI_WORKFLOW_STUB_EXTENSION ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const modelOverride = process.env.PI_WORKFLOW_STUB_MODEL?.trim();
  return new PiProcessExecutor({
    cwd: ctx.cwd,
    onProgress,
    ...(ctx.sessionManager.getSessionFile()
      ? { forkSessionFile: ctx.sessionManager.getSessionFile() }
      : {}),
    extraChildExtensions,
    ...(modelOverride ? { modelOverride } : {}),
  });
}

async function executeWorkflowFromCommand(
  invocation: WorkflowLaunchInvocation,
  ctx: ExtensionCommandContext,
): Promise<string> {
  const resolved = await resolveWorkflowRef(invocation.name, { cwd: ctx.cwd });
  const loaded = await loadWorkflowFile(resolved.path);
  const workflow = applyModelOverrides(loaded, invocation.modelOverrides);
  const startedAt = Date.now();
  const executor = createAgentExecutor(ctx, () => undefined);
  const engine = new WorkflowEngine({ executor });
  try {
    const result = await engine.run(workflow, invocation.input ?? null, {
      workflowPath: path.resolve(resolved.path),
    });
    const presentationPrompt = await resolvePresentationPrompt(
      workflow,
      result.state,
      new AbortController().signal,
    );
    const phase =
      result.state.status === "completed"
        ? "completed"
        : result.state.status === "waiting"
          ? "waiting"
          : "failed";
    const details: WorkflowToolDetails = {
      phase,
      workflowName: workflow.name,
      message: `Workflow ${workflow.name} ${result.state.status}`,
      elapsedMs: Date.now() - startedAt,
      status: result.state.status,
      runId: result.state.runId,
      runDir: result.runDir,
      outputs: result.state.outputs,
      finalOutput: result.state.finalOutput,
      completedSteps: result.state.steps.length,
      currentNodeId: result.state.currentNode ?? result.state.waitingOn,
      nodes: buildNodeProgress({ workflow, state: result.state, phase }),
      ...(presentationPrompt ? { presentationPrompt } : {}),
    };
    if (
      result.state.status === "failed" ||
      result.state.status === "timed_out" ||
      result.state.status === "cancelled"
    ) {
      throw new Error(
        `${details.message}${result.state.error ? `: ${result.state.error}` : ""}\nrunDir: ${result.runDir}`,
      );
    }
    return formatFinalResult(details);
  } finally {
    await executor.dispose();
  }
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
