import { agent, compute, defineWorkflow } from "pi-herdr-workflows";
import { CHEAP } from "../_cheap.js";

/**
 * Level 8: multi-stage pipeline designed for park/resume mid-run.
 * Fast compute stages (`stage1` → `stage2` → `stage3`) with a trivial agent
 * in the middle so park-during-agent tests can target it (mock the executor).
 *
 * Engine APIs: `WorkflowEngine.park()` during `run`, then
 * `WorkflowEngine.resumeRun(workflow, runId, …)`.
 *
 * Live agent needs Herdr; compute-only parking can inject a hanging executor
 * on `midAgent` in tests.
 *
 * Input:  { seed?: string }
 * Output: { stages, seed, mid, packed }
 *
 * Run: /workflow 08-parkable-stages
 *      /workflow 08-parkable-stages {"seed":"alpha"}
 */
export default defineWorkflow({
  name: "08-parkable-stages",
  title: ({ input }) => {
    const seed = seedFrom(input);
    return seed ? `parkable-stages: ${seed.slice(0, 40)}` : "parkable-stages";
  },
  startAt: "stage1",
  presentationPrompt: "Show the three stage markers and the mid-agent echo.",
  nodes: {
    stage1: compute({
      statusDetail: "Stage 1",
      run: ({ input }) => {
        const seed = seedFrom(input) ?? "demo";
        return { stage: "stage1" as const, seed };
      },
    }),
    midAgent: agent({
      statusDetail: "Mid-stage agent (park target)",
      spawn: {
        name: "parkable-mid",
        ...CHEAP,
        tools: "workflow_done",
        cwd: process.cwd(),
      },
      prompt: ({ outputs }) => {
        const stage1 = outputs.stage1 as { stage: string; seed: string };
        return [
          "Return JSON only. No tools.",
          `Echo seed ${JSON.stringify(stage1.seed)} in the echo field.`,
        ].join("\n");
      },
      expectedOutput: `{ "echo": "…" }`,
      validate: (output) => {
        if (output == null || typeof output !== "object" || Array.isArray(output)) {
          throw new Error("output must be a JSON object");
        }
        const echo = (output as { echo?: unknown }).echo;
        if (typeof echo !== "string" || !echo.trim()) {
          throw new Error("echo must be a non-empty string");
        }
        return { echo: echo.trim() };
      },
    }),
    stage2: compute({
      statusDetail: "Stage 2",
      run: ({ outputs }) => {
        const stage1 = outputs.stage1 as { stage: string; seed: string };
        const mid = outputs.midAgent as { echo: string };
        return {
          stage: "stage2" as const,
          seed: stage1.seed,
          midEcho: mid.echo,
        };
      },
    }),
    stage3: compute({
      statusDetail: "Stage 3",
      run: ({ outputs }) => {
        const stage1 = outputs.stage1 as { stage: string; seed: string };
        const stage2 = outputs.stage2 as {
          stage: string;
          seed: string;
          midEcho: string;
        };
        const mid = outputs.midAgent as { echo: string };
        return {
          stages: ["stage1", "midAgent", "stage2", "stage3"],
          seed: stage1.seed,
          mid: mid.echo,
          packed: `${stage2.stage}:${stage2.midEcho}`,
        };
      },
    }),
  },
  edges: [
    { from: "stage1", to: "midAgent" },
    { from: "midAgent", to: "stage2" },
    { from: "stage2", to: "stage3" },
  ],
});

function seedFrom(input: unknown): string | undefined {
  if (typeof input === "string" && input.trim()) return input.trim();
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { seed?: unknown }).seed === "string"
  ) {
    const seed = (input as { seed: string }).seed.trim();
    return seed || undefined;
  }
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { task?: unknown }).task === "string"
  ) {
    const task = (input as { task: string }).task.trim();
    return task || undefined;
  }
  return undefined;
}
