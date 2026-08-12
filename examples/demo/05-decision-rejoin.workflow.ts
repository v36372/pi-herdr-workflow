import { compute, defineWorkflow } from "pi-herdr-workflows";

/**
 * Level 5: compute → switch branches → rejoin.
 *
 * Uses a switch edge on compute output (`$.route`) instead of `decision()` so
 * the graph stays deterministic and mockable without Herdr. For a live model
 * router, see `examples/coin-flip.workflow.ts` / `mood-route.workflow.ts`.
 *
 * Input:  { route?: "left" | "right" }
 * Output: { route, branch, note }
 *
 * Run: /workflow 05-decision-rejoin
 *      /workflow 05-decision-rejoin {"route":"right"}
 */
export default defineWorkflow({
  name: "05-decision-rejoin",
  title: ({ input }) => `decision-rejoin: ${routeFrom(input)}`,
  startAt: "choose",
  presentationPrompt: "Show which branch ran and the rejoined note.",
  nodes: {
    choose: compute({
      statusDetail: "Choosing left/right route",
      run: ({ input }) => ({
        route: routeFrom(input),
      }),
    }),
    leftBranch: compute({
      statusDetail: "Left branch",
      run: ({ outputs }) => ({
        route: "left" as const,
        branch: "left",
        detail: (outputs.choose as { route: string }).route,
      }),
    }),
    rightBranch: compute({
      statusDetail: "Right branch",
      run: ({ outputs }) => ({
        route: "right" as const,
        branch: "right",
        detail: (outputs.choose as { route: string }).route,
      }),
    }),
    rejoin: compute({
      statusDetail: "Rejoining branches",
      run: ({ outputs }) => {
        const branch = (outputs.leftBranch ?? outputs.rightBranch) as {
          route: string;
          branch: string;
          detail: string;
        };
        return {
          route: branch.route,
          branch: branch.branch,
          note: `took ${branch.branch} path`,
        };
      },
    }),
  },
  edges: [
    {
      from: "choose",
      switch: {
        on: "$.route",
        cases: {
          left: "leftBranch",
          right: "rightBranch",
        },
      },
    },
    { from: "leftBranch", to: "rejoin" },
    { from: "rightBranch", to: "rejoin" },
  ],
});

function routeFrom(input: unknown): "left" | "right" {
  if (
    typeof input === "object" &&
    input !== null &&
    (input as { route?: unknown }).route === "right"
  ) {
    return "right";
  }
  return "left";
}
