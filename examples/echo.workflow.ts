import { agent, defineWorkflow } from "pi-herdr-workflows";

/**
 * Minimal example: one agent node with subagent-style spawn params.
 * When run via the extension, Herdr opens a workspace, puts the agent in a
 * pane, and the child calls workflow_done with { reply }.
 */
export default defineWorkflow({
  name: "echo",
  startAt: "reply",
  nodes: {
    reply: agent({
      spawn: {
        name: "echo-agent",
        // agent: "worker", // optional: load project/global agents/worker.md defaults
        // model: "anthropic/claude-sonnet-4-6",
        // tools: "read,bash,grep,find,ls",
        // cwd: process.cwd(),
      },
      prompt: ({ input }) =>
        `Answer concisely: ${(input as { task?: string }).task ?? "say hello"}`,
      expectedOutput: `{ "reply": "your concise answer" }`,
    }),
  },
  edges: [],
});
