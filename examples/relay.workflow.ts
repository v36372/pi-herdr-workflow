import { agent, compute, defineWorkflow } from "pi-herdr-workflows";
import { CHEAP } from "./_cheap.js";

/**
 * Two trivial agent steps in a row, then compute.
 * Shows multi-agent progress without real repo work.
 *
 * Run: /workflow relay
 *      /workflow relay ocean
 */
export default defineWorkflow({
  name: "relay",
  title: ({ input }) => `relay: ${seedFrom(input) ?? "word"}`,
  startAt: "pick",
  presentationPrompt: "Show the picked word and the shouted form.",
  nodes: {
    pick: agent({
      statusDetail: "Picking a word",
      spawn: {
        name: "picker",
        ...CHEAP,
        tools: "workflow_done",
      },
      prompt: ({ input }) => {
        const seed = seedFrom(input);
        return [
          "Pick exactly one ordinary English noun.",
          seed ? `Prefer something related to: ${seed}` : "Any common noun is fine.",
          "No tools. Submit JSON only.",
        ].join("\n");
      },
      expectedOutput: `{ "word": "ocean" }`,
      validate: (output) => {
        const value = asObject(output);
        if (typeof value.word !== "string" || !value.word.trim()) {
          throw new Error("word must be a non-empty string");
        }
        const word = value.word.trim().split(/\s+/)[0]!;
        if (!/^[A-Za-z]+$/.test(word)) {
          throw new Error("word must be a single alphabetic token");
        }
        return { word: word.toLowerCase() };
      },
    }),
    shout: agent({
      statusDetail: "Shouting the word",
      spawn: {
        name: "shouter",
        ...CHEAP,
        tools: "workflow_done",
      },
      prompt: ({ outputs }) => {
        const pick = outputs.pick as { word: string };
        return [
          `Previous node picked the word: ${pick.word}`,
          "Return that same word uppercased. Do not pick a new word.",
          "No tools. Submit JSON only.",
        ].join("\n");
      },
      expectedOutput: `{ "shout": "OCEAN" }`,
      validate: (output, { outputs }) => {
        const value = asObject(output);
        const pick = outputs.pick as { word: string };
        if (typeof value.shout !== "string" || !value.shout.trim()) {
          throw new Error("shout must be a non-empty string");
        }
        const shout = value.shout.trim();
        if (shout !== pick.word.toUpperCase()) {
          throw new Error(`shout must be ${pick.word.toUpperCase()}`);
        }
        return { shout };
      },
    }),
    pack: compute({
      statusDetail: "Packing relay",
      run: ({ outputs }) => {
        const pick = outputs.pick as { word: string };
        const shout = outputs.shout as { shout: string };
        return {
          word: pick.word,
          shout: shout.shout,
          steps: 2,
        };
      },
    }),
  },
  edges: [
    { from: "pick", to: "shout" },
    { from: "shout", to: "pack" },
  ],
});

function seedFrom(input: unknown): string | undefined {
  if (typeof input === "string" && input.trim()) return input.trim();
  if (
    typeof input === "object" &&
    input !== null &&
    "seed" in input &&
    typeof (input as { seed?: unknown }).seed === "string"
  ) {
    const seed = (input as { seed: string }).seed.trim();
    return seed || undefined;
  }
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
