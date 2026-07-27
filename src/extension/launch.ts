import path from "node:path";
import type {
  AgentNodeDefinition,
  WorkflowDefinition,
} from "../workflows/types.js";
import type { DiscoveredWorkflow } from "../workflows/loader.js";

/** Agent-backed node that can take a model override at launch time. */
export type WorkflowAgentStep = {
  nodeId: string;
  /** Author statusDetail, spawn.name, or nodeId. */
  label: string;
  /** Effective authored or Pi default model. */
  defaultModel?: string;
};

export type WorkflowModelOverrides = Record<string, string>;

export type WorkflowLaunchInvocation = {
  name: string;
  input: unknown;
  modelOverrides?: WorkflowModelOverrides;
};

/** Finish the agent-model list and continue launch. */
export const DONE_AGENT_MODELS_OPTION = "Done — run with these models";
/** Clear every override and return to the step list. */
export const RESET_AGENT_MODELS_OPTION = "Reset all to defaults";

/**
 * Model refs match the spawn.model surface (`provider/id`), allowing common
 * id characters used by pi model catalogs.
 */
const MODEL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/: -]*$/;

/** Select-menu label for a discovered workflow. */
export function formatWorkflowOption(workflow: DiscoveredWorkflow): string {
  return `${workflow.name}  · ${workflow.source}`;
}

/** Recover the workflow name from a {@link formatWorkflowOption} label. */
export function parseWorkflowOption(option: string): string {
  const sep = option.indexOf("  · ");
  return sep === -1 ? option.trim() : option.slice(0, sep).trim();
}

/** List agent-backed steps (agent + decision nodes) in definition order. */
export function listAgentSteps(
  workflow: WorkflowDefinition,
  piDefaultModel?: string,
): WorkflowAgentStep[] {
  const steps: WorkflowAgentStep[] = [];
  for (const [nodeId, node] of Object.entries(workflow.nodes)) {
    if (node.nodeType !== "agent") continue;
    steps.push(describeAgentStep(nodeId, node, piDefaultModel));
  }
  return steps;
}

function describeAgentStep(
  nodeId: string,
  node: AgentNodeDefinition,
  piDefaultModel: string | undefined,
): WorkflowAgentStep {
  const statusDetail =
    typeof node.statusDetail === "string" && node.statusDetail.trim()
      ? node.statusDetail.trim()
      : undefined;
  const spawnName =
    typeof node.spawn?.name === "string" && node.spawn.name.trim()
      ? node.spawn.name.trim()
      : undefined;
  const defaultModel =
    typeof node.spawn?.model === "string" && node.spawn.model.trim()
      ? node.spawn.model.trim()
      : piDefaultModel;
  return {
    nodeId,
    label: statusDetail ?? spawnName ?? nodeId,
    ...(defaultModel ? { defaultModel } : {}),
  };
}

/** Format a registry model as the same `provider/id` string spawn.model uses. */
export function formatModelRef(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Resolve configured scoped-model patterns against currently available models.
 * Pattern order wins, matching Pi's model-cycle ordering. No configured scope
 * means every available model is suggested.
 */
export function filterModelRefsByScope(
  models: Array<{ provider: string; id: string }>,
  patterns: string[] | undefined,
): string[] {
  const catalog = models.map((model) => ({
    ref: formatModelRef(model),
    id: model.id,
  }));
  if (!patterns?.length) return catalog.map(({ ref }) => ref);

  const refs: string[] = [];
  const seen = new Set<string>();
  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim().replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/i, "");
    if (!pattern) continue;

    for (const model of catalog) {
      if (!matchesModelScopePattern(model, pattern) || seen.has(model.ref)) continue;
      seen.add(model.ref);
      refs.push(model.ref);
    }
  }
  return refs;
}

function matchesModelScopePattern(
  model: { ref: string; id: string },
  pattern: string,
): boolean {
  const normalizedPattern = pattern.toLowerCase();
  const ref = model.ref.toLowerCase();
  const id = model.id.toLowerCase();
  if (!/[?*[]/.test(normalizedPattern)) {
    return ref === normalizedPattern || id === normalizedPattern;
  }
  try {
    return path.matchesGlob(ref, normalizedPattern) || path.matchesGlob(id, normalizedPattern);
  } catch {
    return false;
  }
}

/** Effective model label for a step given current overrides. */
export function effectiveModelLabel(
  step: WorkflowAgentStep,
  overrides: WorkflowModelOverrides,
): string {
  const override = overrides[step.nodeId]?.trim();
  if (override) return override;
  if (step.defaultModel) return `${step.defaultModel} (default)`;
  return "(workflow default)";
}

/**
 * One select-row for an agent step. Stable parse key is the node id before the
 * first `  · ` separator.
 */
export function formatAgentStepOption(
  step: WorkflowAgentStep,
  overrides: WorkflowModelOverrides,
): string {
  return `${step.nodeId}  · ${step.label}  · ${effectiveModelLabel(step, overrides)}`;
}

/** Recover node id from a {@link formatAgentStepOption} row. */
export function parseAgentStepOption(option: string): string {
  const sep = option.indexOf("  · ");
  return sep === -1 ? option.trim() : option.slice(0, sep).trim();
}

/**
 * Full model-config menu: every agent step, then Done / Reset actions.
 * User can re-enter any step freely until Done.
 */
export function buildAgentModelMenuOptions(
  steps: WorkflowAgentStep[],
  overrides: WorkflowModelOverrides,
): string[] {
  return [
    ...steps.map((step) => formatAgentStepOption(step, overrides)),
    DONE_AGENT_MODELS_OPTION,
    RESET_AGENT_MODELS_OPTION,
  ];
}

export function isDoneAgentModelsOption(option: string): boolean {
  return option === DONE_AGENT_MODELS_OPTION;
}

export function isResetAgentModelsOption(option: string): boolean {
  return option === RESET_AGENT_MODELS_OPTION;
}

export function isValidModelRef(value: string): boolean {
  return MODEL_REF_PATTERN.test(value.trim());
}

/**
 * Resolve free-text model input for one step.
 * Empty, cancel (`undefined`), or invalid → keep default (no override).
 * Valid `provider/id` → override.
 */
export function resolveModelInput(
  raw: string | undefined,
  defaultModel: string | undefined,
): { kind: "default" } | { kind: "override"; model: string } | { kind: "invalid"; raw: string } {
  if (raw === undefined) return { kind: "default" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "default" };
  if (defaultModel && trimmed === defaultModel) return { kind: "default" };
  if (!isValidModelRef(trimmed)) return { kind: "invalid", raw: trimmed };
  return { kind: "override", model: trimmed };
}

/** Title for the per-step model input dialog. */
export function modelInputTitle(step: WorkflowAgentStep): string {
  return `Model for ${step.label} (${step.nodeId})`;
}

/**
 * Placeholder / hint for the input dialog. Shows the authored default when
 * present so empty/cancel clearly means "keep default".
 */
export function modelInputHint(step: WorkflowAgentStep): string {
  if (step.defaultModel) {
    return `${step.defaultModel}  · empty or Esc keeps default`;
  }
  return "provider/model  · empty or Esc keeps Pi default";
}

/**
 * Apply launch-time model overrides onto agent nodes. Unknown node ids and
 * non-agent nodes are ignored. Returns a shallow-cloned definition.
 */
export function applyModelOverrides(
  workflow: WorkflowDefinition,
  overrides: WorkflowModelOverrides | undefined,
): WorkflowDefinition {
  if (!overrides) return workflow;
  const entries = Object.entries(overrides).filter(
    ([, model]) => typeof model === "string" && model.trim().length > 0,
  );
  if (entries.length === 0) return workflow;

  const nodes: WorkflowDefinition["nodes"] = { ...workflow.nodes };
  for (const [nodeId, model] of entries) {
    const node = nodes[nodeId];
    if (!node || node.nodeType !== "agent") continue;
    nodes[nodeId] = {
      ...node,
      spawn: {
        ...node.spawn,
        model: model.trim(),
      },
    };
  }
  return { ...workflow, nodes };
}

/** Build the orchestrator turn that forces a single `workflow` tool call. */
export function buildWorkflowLaunchPrompt(invocation: WorkflowLaunchInvocation): string {
  return [
    `Run the deterministic workflow ${JSON.stringify(invocation.name)} now.`,
    "Call the `workflow` tool exactly once with these arguments:",
    JSON.stringify(invocation),
    "The tool itself follows the workflow file, dispatches Herdr agents, waits for their lifecycle signals, and streams progress. Do not execute workflow nodes manually. After it returns, present the result.",
  ].join("\n");
}
