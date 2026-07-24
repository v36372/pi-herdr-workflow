import { compute, decision, decisionEdge, defineWorkflow } from "pi-herdr-workflows";
import { CHEAP } from "./_cheap.js";

/**
 * Smallest multi-step graph that uses a decision node.
 * One closed choice, two compute branches, rejoin.
 *
 * Run: /workflow coin-flip
 */
const SIDES = ["heads", "tails"] as const;

export default defineWorkflow({
  name: "coin-flip",
  title: "coin-flip",
  startAt: "flip",
  presentationPrompt: "Say heads or tails and the short reason.",
  nodes: {
    flip: decision({
      statusDetail: "Flipping coin",
      spawn: {
        name: "flip",
        ...CHEAP,
        // No tools: pure judgment / random closed choice.
        tools: "workflow_done",
      },
      question: () =>
        [
          "Pretend you flip a fair coin once.",
          "Pick heads or tails. Give a one-word vibe in reason.",
        ].join("\n"),
      choices: SIDES,
    }),
    headsPath: compute({
      statusDetail: "Heads branch",
      run: ({ outputs }) => ({
        side: "heads",
        emoji: "🪙",
        flip: outputs.flip,
      }),
    }),
    tailsPath: compute({
      statusDetail: "Tails branch",
      run: ({ outputs }) => ({
        side: "tails",
        emoji: "🦅",
        flip: outputs.flip,
      }),
    }),
    pack: compute({
      statusDetail: "Packing flip result",
      run: ({ outputs }) => {
        const branch = (outputs.headsPath ?? outputs.tailsPath) as {
          side: string;
          emoji: string;
          flip: { route: string; reason?: string };
        };
        return {
          side: branch.side,
          emoji: branch.emoji,
          reason: branch.flip.reason ?? "",
        };
      },
    }),
  },
  edges: [
    decisionEdge({
      from: "flip",
      choices: SIDES,
      cases: { heads: "headsPath", tails: "tailsPath" },
    }),
    { from: "headsPath", to: "pack" },
    { from: "tailsPath", to: "pack" },
  ],
});
