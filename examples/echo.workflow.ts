import { agent, defineWorkflow } from "pi-herdr-workflows";
import { CHEAP } from "./_cheap.js";

/**
 * Minimal agent node. Child calls workflow_done with { reply }.
 *
 * Run: /workflow echo say hello in one sentence
 */
export default defineWorkflow({
  name: "echo",
  startAt: "reply",
  presentationPrompt: "Present the reply in one short line.",
  nodes: {
    reply: agent({
      statusDetail: "Answering",
      spawn: {
        name: "echo-agent",
        ...CHEAP,
        tools: "workflow_done",
      },
      prompt: ({ input }) =>
        `Answer concisely: ${(input as { task?: string }).task ?? "say hello"}`,
      expectedOutput: `{ "reply": "your concise answer" }`,
      validate: (output) => {
        if (output == null || typeof output !== "object" || Array.isArray(output)) {
          throw new Error("output must be an object");
        }
        const reply = (output as { reply?: unknown }).reply;
        if (typeof reply !== "string" || !reply.trim()) {
          throw new Error("reply must be a non-empty string");
        }
        return { reply: reply.trim() };
      },
    }),
  },
  edges: [],
});
