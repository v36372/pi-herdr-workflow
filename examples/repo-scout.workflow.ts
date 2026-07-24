import { agent, defineWorkflow } from "pi-herdr-workflows";
import { CHEAP } from "./_cheap.js";

/**
 * One read-only agent with a JSON contract.
 *
 * Run: /workflow repo-scout
 *      /workflow repo-scout map the engine
 */
export default defineWorkflow({
  name: "repo-scout",
  title: ({ input }) => {
    const task = taskFrom(input);
    return task ? `scout: ${task.slice(0, 60)}` : "repo-scout";
  },
  startAt: "scout",
  presentationPrompt:
    "Present the scout summary, list key paths, and call out risks in bullets.",
  nodes: {
    scout: agent({
      statusDetail: "Scouting repository",
      spawn: {
        name: "scout",
        ...CHEAP,
        tools: "read,bash,grep,find,ls",
        cwd: process.cwd(),
      },
      prompt: ({ input }) => {
        const task = taskFrom(input) || "Map what this repository does and where the core lives.";
        return [
          "You are a read-only scout. Do not modify files.",
          "",
          `Task: ${task}`,
          "",
          "Inspect the tree with the available tools, then submit JSON only.",
          "Prefer evidence from README, package.json, and src/ entrypoints.",
          "Keep the answer short.",
        ].join("\n");
      },
      expectedOutput: `{ "summary": "1-3 sentences", "paths": ["relative/path"], "risks": ["short risk"] }`,
      validate: (output) => {
        const value = asObject(output);
        const summary = value.summary;
        const paths = value.paths;
        const risks = value.risks;
        if (typeof summary !== "string" || summary.trim().length === 0) {
          throw new Error("summary must be a non-empty string");
        }
        if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) {
          throw new Error("paths must be an array of strings");
        }
        if (!Array.isArray(risks) || !risks.every((r) => typeof r === "string")) {
          throw new Error("risks must be an array of strings");
        }
        return {
          summary: summary.trim(),
          paths,
          risks,
        };
      },
    }),
  },
  edges: [],
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
