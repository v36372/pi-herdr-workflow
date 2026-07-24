import {
  agent,
  compute,
  decision,
  decisionEdge,
  defineWorkflow,
} from "pi-herdr-workflows";
import { CHEAP } from "./_cheap.js";

/**
 * Scout → decision → rejoin compute.
 *
 * Run: /workflow risk-route should we ship this change
 */
const ROUTES = ["ship", "fix"] as const;

export default defineWorkflow({
  name: "risk-route",
  title: ({ input }) => `risk-route: ${taskFrom(input)?.slice(0, 48) ?? "change"}`,
  startAt: "scout",
  presentationPrompt:
    "State the route (ship/fix), the reason, and the scout summary. Keep it short.",
  nodes: {
    scout: agent({
      statusDetail: "Scouting change surface",
      spawn: {
        name: "scout",
        ...CHEAP,
        tools: "read,bash,grep,find,ls",
        cwd: process.cwd(),
      },
      prompt: ({ input }) => {
        const task =
          taskFrom(input) ||
          "Assess whether the current uncommitted or recent workflow changes look safe to ship.";
        return [
          "Read-only scout for a risk decision. Keep it short.",
          `Task: ${task}`,
          "Return the smallest evidence set that supports ship vs fix.",
        ].join("\n");
      },
      expectedOutput: `{ "summary": "…", "paths": ["…"], "concerns": ["…"] }`,
      validate: (output) => {
        const value = asObject(output);
        if (typeof value.summary !== "string") throw new Error("summary required");
        if (!Array.isArray(value.paths)) throw new Error("paths must be an array");
        if (!Array.isArray(value.concerns)) throw new Error("concerns must be an array");
        return value;
      },
    }),
    route: decision({
      statusDetail: "Choosing ship or fix",
      spawn: {
        name: "router",
        ...CHEAP,
        tools: "read",
        cwd: process.cwd(),
      },
      question: ({ outputs }) =>
        [
          "Choose ship or fix for this change.",
          "Use only the scout evidence below.",
          "",
          JSON.stringify(outputs.scout, null, 2),
        ].join("\n"),
      choices: ROUTES,
    }),
    shipNote: compute({
      statusDetail: "Packing ship note",
      run: ({ outputs }) => ({
        note: "ship",
        detail: "Risk accepted; no blocking concerns for a demo ship path.",
        route: outputs.route,
        scout: outputs.scout,
      }),
    }),
    fixNote: compute({
      statusDetail: "Packing fix note",
      run: ({ outputs }) => ({
        note: "fix",
        detail: "Do not ship yet; address scout concerns first.",
        route: outputs.route,
        scout: outputs.scout,
      }),
    }),
    pack: compute({
      statusDetail: "Final package",
      run: ({ outputs }) => {
        const branch = (outputs.shipNote ?? outputs.fixNote) as {
          note: string;
          detail: string;
          route: { route: string; reason?: string };
          scout: unknown;
        };
        return {
          route: branch.route.route,
          reason: branch.route.reason ?? branch.detail,
          scout: branch.scout,
          note: branch.detail,
        };
      },
    }),
  },
  edges: [
    { from: "scout", to: "route" },
    decisionEdge({
      from: "route",
      choices: ROUTES,
      cases: { ship: "shipNote", fix: "fixNote" },
    }),
    { from: "shipNote", to: "pack" },
    { from: "fixNote", to: "pack" },
  ],
});

function taskFrom(input: unknown): string | undefined {
  if (typeof input === "string" && input.trim()) return input.trim();
  if (
    typeof input === "object" &&
    input !== null &&
    "task" in input &&
    typeof (input as { task?: unknown }).task === "string"
  ) {
    const task = (input as { task: string }).task.trim();
    return task || undefined;
  }
  return undefined;
}

function asObject(output: unknown): Record<string, unknown> {
  if (output == null || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("output must be a JSON object");
  }
  return output as Record<string, unknown>;
}
