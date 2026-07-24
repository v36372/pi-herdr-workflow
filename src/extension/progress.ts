import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { WorkflowDefinition, WorkflowRunState } from "../workflows/types.js";

export type WorkflowNodeUiStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type WorkflowNodeProgress = {
  id: string;
  nodeType: string;
  status: WorkflowNodeUiStatus;
  /** Author-provided one-liner (`statusDetail`), else spawn name. */
  summary?: string;
};

export type WorkflowProgressSnapshot = {
  workflowName: string;
  phase: "starting" | "running" | "completed" | "waiting" | "failed";
  elapsedMs: number;
  message: string;
  nodes: WorkflowNodeProgress[];
  currentNodeId?: string;
  /** Runtime node kind for the current step (agent/action/compute/…). */
  currentNodeType?: string;
  /** Human one-liner for whatever the engine is doing right now (any node kind). */
  activity?: string;
  agentName?: string;
  paneId?: string;
  status?: WorkflowRunState["status"];
  runDir?: string;
  /**
   * Spinner frame index for the live running mark. The tool partial ticker
   * advances this; static renders may leave it unset (first frame).
   */
  spinnerFrame?: number;
};

type ThemeLike = {
  fg: (name: ThemeColor, text: string) => string;
  bold: (text: string) => string;
  strikethrough?: (text: string) => string;
};

/**
 * Pi default working-indicator frames (`@earendil-works/pi-tui` Loader /
 * WorkingStatusIndicator). Used for in-progress agent steps.
 */
export const PI_DEFAULT_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

/** BFS from startAt so sibling branches appear as a group after their parent. */
export function orderWorkflowNodes(workflow: WorkflowDefinition): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const queue = [workflow.startAt];
  while (queue.length > 0) {
    const nodeId = queue.shift() as string;
    if (seen.has(nodeId) || !Object.hasOwn(workflow.nodes, nodeId)) continue;
    seen.add(nodeId);
    ordered.push(nodeId);
    for (const edge of workflow.edges) {
      if (edge.from !== nodeId) continue;
      const targets = "to" in edge ? [edge.to] : Object.values(edge.switch.cases);
      for (const target of targets) {
        if (!seen.has(target)) queue.push(target);
      }
    }
  }
  for (const nodeId of Object.keys(workflow.nodes)) {
    if (!seen.has(nodeId)) ordered.push(nodeId);
  }
  return ordered;
}

export function buildNodeProgress(args: {
  workflow: WorkflowDefinition;
  state?: Pick<WorkflowRunState, "results" | "currentNode" | "status" | "waitingOn">;
  currentNodeId?: string;
  phase: WorkflowProgressSnapshot["phase"];
}): WorkflowNodeProgress[] {
  const { workflow, state, phase } = args;
  const currentNodeId = args.currentNodeId ?? state?.currentNode;
  const terminal =
    phase === "completed" ||
    phase === "failed" ||
    state?.status === "completed" ||
    state?.status === "failed" ||
    state?.status === "timed_out" ||
    state?.status === "cancelled";

  // Only model-backed steps (agent + decision helpers) — compute/shell/action
  // noise is not useful in the live progress strip.
  return orderWorkflowNodes(workflow)
    .filter((id) => workflow.nodes[id]?.nodeType === "agent")
    .map((id) => {
      const node = workflow.nodes[id]!;
      const result = state?.results[id];
      let status: WorkflowNodeUiStatus = "pending";
      if (result?.outcome === "ok") {
        status = "done";
      } else if (
        result?.outcome === "failed" ||
        result?.outcome === "timed_out" ||
        result?.outcome === "cancelled"
      ) {
        status = "failed";
      } else if (currentNodeId === id || state?.waitingOn === id) {
        status = phase === "failed" ? "failed" : "running";
      } else if (terminal) {
        status = "skipped";
      }
      const summary = nodeSummary(node);
      return {
        id,
        nodeType: node.nodeType,
        status,
        ...(summary ? { summary } : {}),
      };
    });
}

/** Prefer author `statusDetail`; fall back to a static spawn name. */
function nodeSummary(node: WorkflowDefinition["nodes"][string]): string | undefined {
  if (typeof node.statusDetail === "string" && node.statusDetail.trim()) {
    return node.statusDetail.trim();
  }
  if (node.nodeType === "agent") {
    const name = node.spawn?.name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return undefined;
}

/**
 * Icons (pi-tasks / Claude Code style for terminal states; Pi default braille
 * spinner for the live running mark):
 *   ✔ done · ⠋… running · ◻ pending/skipped · ✗ failed
 */
export function statusMark(
  status: WorkflowNodeUiStatus,
  spinnerFrame = 0,
): string {
  switch (status) {
    case "done":
      return "✔";
    case "running":
      return PI_DEFAULT_SPINNER_FRAMES[
        ((spinnerFrame % PI_DEFAULT_SPINNER_FRAMES.length) +
          PI_DEFAULT_SPINNER_FRAMES.length) %
          PI_DEFAULT_SPINNER_FRAMES.length
      ]!;
    case "failed":
      return "✗";
    case "skipped":
    case "pending":
      return "◻";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function formatElapsed(elapsedMs: number): string {
  const totalSec = Math.floor(elapsedMs / 1_000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

/** Resolve the live activity one-liner (shell/compute/agent). */
export function resolveActivity(snapshot: WorkflowProgressSnapshot): string | undefined {
  const candidates = [snapshot.activity, snapshot.message];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() && !isHerdrNoise(candidate)) {
      return candidate.trim();
    }
  }
  const running = snapshot.nodes.find((node) => node.status === "running");
  if (running?.summary) return running.summary;
  return undefined;
}

function countByStatus(nodes: WorkflowNodeProgress[]): {
  done: number;
  running: number;
  open: number;
  failed: number;
} {
  let done = 0;
  let running = 0;
  let open = 0;
  let failed = 0;
  for (const node of nodes) {
    if (node.status === "done") done += 1;
    else if (node.status === "running") running += 1;
    else if (node.status === "failed") failed += 1;
    else open += 1; // pending + skipped
  }
  return { done, running, open, failed };
}

/** pi-tasks-style header: "● N steps (1 done, 1 in progress, 2 open)" */
export function formatStepsHeader(snapshot: WorkflowProgressSnapshot): string {
  const { done, running, open, failed } = countByStatus(snapshot.nodes);
  const parts: string[] = [];
  if (done > 0) parts.push(`${done} done`);
  if (running > 0) parts.push(`${running} in progress`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (open > 0) parts.push(`${open} open`);
  const counts =
    snapshot.nodes.length === 0
      ? "0 steps"
      : parts.length > 0
        ? `${snapshot.nodes.length} steps (${parts.join(", ")})`
        : `${snapshot.nodes.length} steps`;
  return `● ${snapshot.workflowName} · ${counts} · ${formatElapsed(snapshot.elapsedMs)}`;
}

/**
 * Compact one-line status. Kept for tests and callers that want a single line;
 * the live tool partial uses {@link formatProgressText} (full checklist).
 */
export function formatActivityText(snapshot: WorkflowProgressSnapshot): string {
  const parts = [
    snapshot.workflowName,
    snapshot.status ?? snapshot.phase,
    formatElapsed(snapshot.elapsedMs),
  ];
  if (snapshot.currentNodeId) {
    const kind =
      snapshot.currentNodeType && snapshot.currentNodeType !== "agent"
        ? `${snapshot.currentNodeId} (${snapshot.currentNodeType})`
        : snapshot.currentNodeId;
    parts.push(kind);
  }
  const activity = resolveActivity(snapshot);
  if (activity) parts.push(activity);
  if (snapshot.agentName) parts.push(snapshot.agentName);
  return parts.join(" · ");
}

/** Label for a step line: subject (summary) preferred, else node id. */
function stepLabel(node: WorkflowNodeProgress): string {
  return node.summary?.trim() || node.id;
}

/** Active form like pi-tasks: continuous-ish summary with ellipsis. */
function activeForm(node: WorkflowNodeProgress): string {
  const base = stepLabel(node);
  return base.endsWith("…") || base.endsWith("...") ? base : `${base}…`;
}

/** Plain-text strikethrough via combining long stroke overlay (no theme needed). */
export function plainStrikethrough(text: string): string {
  return Array.from(text)
    .map((ch) => `${ch}\u0336`)
    .join("");
}

/**
 * Step checklist for the in-chat tool call (partial updates + settled result).
 * Visual language from @tintinweb/pi-tasks + Pi default braille spinner:
 *   ● N steps (counts)
 *     ✔ #1 done subject   (strikethrough)
 *     ⠋ #2 active form…
 *     ◻ #3 pending subject
 */
export function formatProgressText(snapshot: WorkflowProgressSnapshot): string {
  const spinnerFrame = snapshot.spinnerFrame ?? 0;
  const lines = [formatStepsHeader(snapshot)];

  // Non-agent work is invisible in the step list — surface it under the header.
  const onAgent =
    snapshot.currentNodeType === "agent" ||
    snapshot.nodes.some((node) => node.status === "running" && node.id === snapshot.currentNodeId);
  const activity = resolveActivity(snapshot);
  if (activity && !onAgent && snapshot.currentNodeId) {
    const kind =
      snapshot.currentNodeType && snapshot.currentNodeType !== "agent"
        ? `${snapshot.currentNodeId} (${snapshot.currentNodeType})`
        : snapshot.currentNodeId;
    lines.push(`  now  ${kind} · ${activity}`);
  }

  snapshot.nodes.forEach((node, index) => {
    const n = index + 1;
    const mark = statusMark(node.status, spinnerFrame);
    if (node.status === "running") {
      lines.push(`  ${mark} #${n} ${activeForm(node)}`);
    } else if (node.status === "done") {
      lines.push(`  ${mark} ${plainStrikethrough(`#${n} ${stepLabel(node)}`)}`);
    } else {
      lines.push(`  ${mark} #${n} ${stepLabel(node)}`);
    }
  });

  return lines.join("\n");
}

function isHerdrNoise(message: string): boolean {
  return /\bherdr\b/i.test(message) || /\bagent (start|prompt|wait)\b/i.test(message);
}

/** Compact themed one-liner (optional surface; tool partial uses full checklist). */
export function formatActivityThemed(snapshot: WorkflowProgressSnapshot, theme: ThemeLike): string {
  const phaseColor =
    snapshot.phase === "completed"
      ? "success"
      : snapshot.phase === "failed"
        ? "error"
        : snapshot.phase === "waiting"
          ? "warning"
          : "accent";
  const text = formatActivityText(snapshot);
  const sep = text.indexOf(" · ");
  if (sep === -1) return theme.fg(phaseColor, theme.bold(text));
  return theme.fg(phaseColor, theme.bold(text.slice(0, sep))) + theme.fg("dim", text.slice(sep));
}

/** Themed agent checklist — pi-tasks colors + completed strikethrough. */
export function formatProgressThemed(snapshot: WorkflowProgressSnapshot, theme: ThemeLike): string {
  const phaseColor =
    snapshot.phase === "completed"
      ? "success"
      : snapshot.phase === "failed"
        ? "error"
        : snapshot.phase === "waiting"
          ? "warning"
          : "accent";

  const spinnerFrame = snapshot.spinnerFrame ?? 0;
  const headerPlain = formatStepsHeader(snapshot);
  // Color the bullet + workflow name segment; rest dim.
  const afterBullet = headerPlain.startsWith("● ") ? headerPlain.slice(2) : headerPlain;
  const nameSep = afterBullet.indexOf(" · ");
  const header =
    theme.fg(phaseColor, "●") +
    " " +
    (nameSep === -1
      ? theme.fg(phaseColor, theme.bold(afterBullet))
      : theme.fg(phaseColor, theme.bold(afterBullet.slice(0, nameSep))) +
        theme.fg("dim", afterBullet.slice(nameSep)));

  const lines = [header];

  const onAgent =
    snapshot.currentNodeType === "agent" ||
    snapshot.nodes.some((node) => node.status === "running" && node.id === snapshot.currentNodeId);
  const activity = resolveActivity(snapshot);
  if (activity && !onAgent && snapshot.currentNodeId) {
    const kind =
      snapshot.currentNodeType && snapshot.currentNodeType !== "agent"
        ? `${snapshot.currentNodeId} (${snapshot.currentNodeType})`
        : snapshot.currentNodeId;
    lines.push(theme.fg("dim", `  now  ${kind} · ${activity}`));
  }

  snapshot.nodes.forEach((node, index) => {
    const n = index + 1;
    const mark = themeStatusMark(node.status, theme, spinnerFrame);
    const idLabel = `#${n}`;
    if (node.status === "running") {
      const form = activeForm(node);
      lines.push(`  ${mark} ${theme.fg("dim", idLabel)} ${theme.fg("accent", form)}`);
    } else if (node.status === "done") {
      const body = `${idLabel} ${stepLabel(node)}`;
      const struck = theme.strikethrough ? theme.strikethrough(body) : plainStrikethrough(body);
      lines.push(`  ${mark} ${theme.fg("dim", struck)}`);
    } else if (node.status === "failed") {
      lines.push(`  ${mark} ${theme.fg("dim", idLabel)} ${theme.fg("error", stepLabel(node))}`);
    } else {
      lines.push(`  ${mark} ${theme.fg("dim", idLabel)} ${stepLabel(node)}`);
    }
  });

  return lines.join("\n");
}

function themeStatusMark(
  status: WorkflowNodeUiStatus,
  theme: ThemeLike,
  spinnerFrame = 0,
): string {
  const mark = statusMark(status, spinnerFrame);
  switch (status) {
    case "done":
      return theme.fg("success", mark);
    case "running":
      return theme.fg("accent", mark);
    case "failed":
      return theme.fg("error", mark);
    case "skipped":
    case "pending":
      return theme.fg("dim", mark);
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
