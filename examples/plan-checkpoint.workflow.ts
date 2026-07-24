import { agent, checkpoint, defineWorkflow } from "pi-herdr-workflows";
import { CHEAP } from "./_cheap.js";

/**
 * Model plans, human gate stops the run (`waiting`).
 *
 * Run: /workflow plan-checkpoint
 *      /workflow plan-checkpoint one week rollout
 */
export default defineWorkflow({
  name: "plan-checkpoint",
  title: ({ input }) => `plan: ${taskFrom(input)?.slice(0, 48) ?? "work"}`,
  startAt: "plan",
  presentationPrompt:
    "Show the plan steps and state that the run is waiting on human approval.",
  nodes: {
    plan: agent({
      statusDetail: "Drafting plan",
      spawn: {
        name: "planner",
        ...CHEAP,
        tools: "read,bash,grep,find,ls",
        cwd: process.cwd(),
      },
      prompt: ({ input }) => {
        const task =
          taskFrom(input) ||
          "Draft a one-week plan to harden the workflow engine demos.";
        return [
          "Draft a short, concrete plan. Do not implement anything.",
          `Goal: ${task}`,
          "Return ordered steps with owners as roles (human/agent/ci), not names.",
          "Keep it to 3-5 steps.",
        ].join("\n");
      },
      expectedOutput: `{ "goal": "…", "steps": [{ "id": "1", "title": "…", "owner": "human|agent|ci" }], "risks": ["…"] }`,
      validate: (output) => {
        const value = asObject(output);
        if (typeof value.goal !== "string") throw new Error("goal required");
        if (!Array.isArray(value.steps) || value.steps.length === 0) {
          throw new Error("steps must be a non-empty array");
        }
        return value;
      },
    }),
    approve: checkpoint({
      statusDetail: "Waiting for human approval",
      summary: "Approve or reject the plan before any implementation work.",
      run: ({ outputs }) => ({
        awaiting: "human-approval",
        plan: outputs.plan,
        instructions:
          "Inspect finalOutput.plan. Start a new run for implementation after approval.",
      }),
    }),
  },
  edges: [{ from: "plan", to: "approve" }],
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
