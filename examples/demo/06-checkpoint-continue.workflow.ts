import { checkpoint, compute, defineWorkflow } from "pi-herdr-workflows";

/**
 * Level 6: compute → checkpoint → compute (outgoing edge).
 * Demonstrates continueRun: the first run stops at `waiting`; continueRun
 * carries checkpoint output across the edge into the approval packager.
 *
 * Engine APIs: `WorkflowEngine.run` → status `waiting`, then
 * `WorkflowEngine.continueRun(workflow, parentRunId, answer)`.
 *
 * Input:  { topic?: string }
 * Checkpoint output: { summary, awaiting, draft }
 * Final output: { approved, topic, draft, answer }
 *
 * Run: /workflow 06-checkpoint-continue
 *      /workflow 06-checkpoint-continue {"topic":"ship demo"}
 */
export default defineWorkflow({
  name: "06-checkpoint-continue",
  title: ({ input }) => {
    const topic = topicFrom(input);
    return topic ? `checkpoint-continue: ${topic.slice(0, 40)}` : "checkpoint-continue";
  },
  startAt: "draft",
  presentationPrompt:
    "If waiting, show the draft and that approval is needed. If completed, show the approval package.",
  nodes: {
    draft: compute({
      statusDetail: "Drafting for human review",
      run: ({ input }) => {
        const topic = topicFrom(input) ?? "demo work";
        return {
          topic,
          draft: `Proposal: ${topic}`,
          readyForReview: true as const,
        };
      },
    }),
    gate: checkpoint({
      statusDetail: "Waiting for human approval",
      summary: "Approve or reject the draft before packaging.",
      run: ({ outputs }) => {
        const draft = outputs.draft as {
          topic: string;
          draft: string;
          readyForReview: boolean;
        };
        return {
          awaiting: "human-approval",
          summary: "Approve or reject the draft before packaging.",
          draft,
        };
      },
    }),
    packApproval: compute({
      statusDetail: "Formatting approval package",
      run: ({ outputs, input }) => {
        const gate = outputs.gate as {
          awaiting: string;
          summary: string;
          draft: { topic: string; draft: string };
        };
        return {
          approved: true as const,
          topic: gate.draft.topic,
          draft: gate.draft.draft,
          answer: input,
          gateSummary: gate.summary,
        };
      },
    }),
  },
  edges: [
    { from: "draft", to: "gate" },
    { from: "gate", to: "packApproval" },
  ],
});

function topicFrom(input: unknown): string | undefined {
  if (typeof input === "string" && input.trim()) return input.trim();
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { topic?: unknown }).topic === "string"
  ) {
    const topic = (input as { topic: string }).topic.trim();
    return topic || undefined;
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
