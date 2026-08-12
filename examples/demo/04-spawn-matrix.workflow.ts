import { agent, defineWorkflow } from "pi-herdr-workflows";
import { CHEAP } from "../_cheap.js";

/**
 * Level 4: single agent with the full spawn surface set explicitly.
 * Omits `agent` (needs agent markdown) and `skills` (needs skill discovery).
 *
 * Live runs need Herdr (`HERDR_ENV=1`). Tests should mock the agent executor.
 *
 * Input:  { echo?: string }
 * Output: { echo: string }
 *
 * Run: /workflow 04-spawn-matrix
 *      /workflow 04-spawn-matrix {"echo":"ping"}
 */
export default defineWorkflow({
  name: "04-spawn-matrix",
  title: "spawn-matrix",
  startAt: "echo",
  presentationPrompt: "Show the echoed JSON payload in one short line.",
  nodes: {
    echo: agent({
      statusDetail: "Echoing via full spawn surface",
      spawn: {
        name: "spawn-matrix",
        systemPrompt: "Return only the JSON contract. No tools beyond workflow_done.",
        ...CHEAP,
        tools: "workflow_done",
        extensions: [],
        cwd: process.cwd(),
        kind: "pi",
        fork: false,
        interactive: false,
        closePaneAfterDone: true,
      },
      prompt: ({ input }) => {
        const echo =
          typeof input === "object" &&
          input !== null &&
          typeof (input as { echo?: unknown }).echo === "string"
            ? (input as { echo: string }).echo.trim() || "spawn-matrix"
            : "spawn-matrix";
        return [
          "Return JSON only. No tools.",
          `Echo this exact string in the echo field: ${JSON.stringify(echo)}`,
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
  },
  edges: [],
});
