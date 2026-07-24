import {
  agent,
  compute,
  decision,
  decisionEdge,
  defineWorkflow,
} from "pi-herdr-workflows";
import { CHEAP } from "./_cheap.js";

/**
 * Tiny agent + decision ladder.
 * Agent invents a short vibe phrase; decision labels it up/down; compute packs.
 *
 * Run: /workflow mood-route
 *      /workflow mood-route rainy monday
 */
const MOODS = ["up", "down"] as const;

export default defineWorkflow({
  name: "mood-route",
  title: ({ input }) => `mood: ${seedFrom(input)?.slice(0, 40) ?? "free"}`,
  startAt: "vibe",
  presentationPrompt: "Show the vibe phrase and whether it routed up or down.",
  nodes: {
    vibe: agent({
      statusDetail: "Inventing a vibe",
      spawn: {
        name: "vibe",
        ...CHEAP,
        tools: "workflow_done",
      },
      prompt: ({ input }) => {
        const seed = seedFrom(input);
        return [
          "Invent one short mood phrase (3-6 words).",
          seed ? `Theme: ${seed}` : "Any everyday mood is fine.",
          "No tools. Submit JSON only.",
        ].join("\n");
      },
      expectedOutput: `{ "phrase": "quiet rainy morning" }`,
      validate: (output) => {
        const value = asObject(output);
        if (typeof value.phrase !== "string" || value.phrase.trim().length < 3) {
          throw new Error("phrase must be a short non-empty string");
        }
        return { phrase: value.phrase.trim() };
      },
    }),
    label: decision({
      statusDetail: "Labeling mood up/down",
      spawn: {
        name: "labeler",
        ...CHEAP,
        tools: "workflow_done",
      },
      question: ({ outputs }) => {
        const vibe = outputs.vibe as { phrase: string };
        return [
          "Classify this phrase as up (positive/energized) or down (low/tired).",
          `Phrase: ${vibe.phrase}`,
        ].join("\n");
      },
      choices: MOODS,
    }),
    upPack: compute({
      statusDetail: "Up branch",
      run: ({ outputs }) => ({
        mood: "up",
        phrase: (outputs.vibe as { phrase: string }).phrase,
        label: outputs.label,
      }),
    }),
    downPack: compute({
      statusDetail: "Down branch",
      run: ({ outputs }) => ({
        mood: "down",
        phrase: (outputs.vibe as { phrase: string }).phrase,
        label: outputs.label,
      }),
    }),
    pack: compute({
      statusDetail: "Final pack",
      run: ({ outputs }) => {
        const branch = (outputs.upPack ?? outputs.downPack) as {
          mood: string;
          phrase: string;
          label: { route: string; reason?: string };
        };
        return {
          mood: branch.mood,
          phrase: branch.phrase,
          reason: branch.label.reason ?? "",
        };
      },
    }),
  },
  edges: [
    { from: "vibe", to: "label" },
    decisionEdge({
      from: "label",
      choices: MOODS,
      cases: { up: "upPack", down: "downPack" },
    }),
    { from: "upPack", to: "pack" },
    { from: "downPack", to: "pack" },
  ],
});

function seedFrom(input: unknown): string | undefined {
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
