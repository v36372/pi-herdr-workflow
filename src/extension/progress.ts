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
  agentName?: string;
  paneId?: string;
  status?: WorkflowRunState["status"];
  runDir?: string;
};

type ThemeLike = {
  fg: (name: ThemeColor, text: string) => string;
  bold: (text: string) => string;
};

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

/** ✓ done · ◉ running · ○ pending/skipped · ✗ failed */
export function statusMark(status: WorkflowNodeUiStatus): string {
  switch (status) {
    case "done":
      return "✓";
    case "running":
      return "◉";
    case "failed":
      return "✗";
    case "skipped":
    case "pending":
      return "○";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function formatElapsed(elapsedMs: number): string {
  return `${Math.floor(elapsedMs / 1_000)}s`;
}

/** Plain-text node list for tool content / widget string arrays. */
export function formatProgressText(snapshot: WorkflowProgressSnapshot): string {
  const header = `${snapshot.workflowName} · ${snapshot.status ?? snapshot.phase} · ${formatElapsed(snapshot.elapsedMs)}`;
  const lines = snapshot.nodes.map((node) => {
    const mark = statusMark(node.status);
    // Prefer the author one-liner; only show orchestrator message when blocked/etc.
    const detail =
      node.status === "running"
        ? node.summary ??
          (snapshot.message && !isHerdrNoise(snapshot.message) ? snapshot.message : undefined)
        : node.summary;
    return detail ? `${mark} ${node.id}  ${detail}` : `${mark} ${node.id}`;
  });
  return [header, ...lines].join("\n");
}

function isHerdrNoise(message: string): boolean {
  return /\bherdr\b/i.test(message) || /\bagent (start|prompt|wait)\b/i.test(message);
}

/** Themed TUI block for renderResult. */
export function formatProgressThemed(snapshot: WorkflowProgressSnapshot, theme: ThemeLike): string {
  const phaseColor =
    snapshot.phase === "completed"
      ? "success"
      : snapshot.phase === "failed"
        ? "error"
        : snapshot.phase === "waiting"
          ? "warning"
          : "accent";
  const header =
    theme.fg(phaseColor, theme.bold(snapshot.workflowName)) +
    theme.fg("dim", ` · ${snapshot.status ?? snapshot.phase} · ${formatElapsed(snapshot.elapsedMs)}`);

  const lines = snapshot.nodes.map((node) => {
    const mark = themeStatusMark(node.status, theme);
    const name =
      node.status === "running"
        ? theme.fg("accent", node.id)
        : node.status === "done"
          ? theme.fg("muted", node.id)
          : node.status === "failed"
            ? theme.fg("error", node.id)
            : theme.fg("dim", node.id);
    const detailText =
      node.status === "running"
        ? node.summary ??
          (snapshot.message && !isHerdrNoise(snapshot.message) ? snapshot.message : undefined)
        : node.summary;
    const extra = detailText ? theme.fg("dim", `  ${detailText}`) : "";
    return `${mark} ${name}${extra}`;
  });

  return [header, ...lines].join("\n");
}

function themeStatusMark(status: WorkflowNodeUiStatus, theme: ThemeLike): string {
  const mark = statusMark(status);
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
