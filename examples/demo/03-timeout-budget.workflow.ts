import { compute, defineWorkflow } from "pi-herdr-workflows";

/**
 * Level 3: functional `timeoutMs: (ctx) => number` on a compute node.
 * Derives the budget from `input.budgetMs` (default 5000). The node finishes
 * quickly and observes `signal`, so successful runs exercise the timeout API
 * without hitting the deadline.
 *
 * Input:  { budgetMs?: number, tag?: string }
 * Output: { ok, budgetMs, tag, signalAborted }
 *
 * Run: /workflow 03-timeout-budget
 *      /workflow 03-timeout-budget {"budgetMs":2000,"tag":"fast"}
 */
export default defineWorkflow({
  name: "03-timeout-budget",
  title: ({ input }) => {
    const budget = budgetFrom(input);
    return `timeout-budget: ${budget}ms`;
  },
  startAt: "withinBudget",
  presentationPrompt: "Confirm the run completed within the derived timeout budget.",
  nodes: {
    withinBudget: compute({
      statusDetail: "Working within timeout budget",
      timeoutMs: ({ input }) => budgetFrom(input),
      run: ({ input, signal }) => {
        if (signal.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error(String(signal.reason ?? "aborted"));
        }
        const budgetMs = budgetFrom(input);
        const tag =
          typeof input === "object" &&
          input !== null &&
          typeof (input as { tag?: unknown }).tag === "string"
            ? (input as { tag: string }).tag.trim() || "ok"
            : "ok";
        return {
          ok: true as const,
          budgetMs,
          tag,
          signalAborted: signal.aborted,
        };
      },
    }),
  },
  edges: [],
});

function budgetFrom(input: unknown): number {
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { budgetMs?: unknown }).budgetMs === "number" &&
    Number.isFinite((input as { budgetMs: number }).budgetMs) &&
    (input as { budgetMs: number }).budgetMs > 0
  ) {
    return (input as { budgetMs: number }).budgetMs;
  }
  return 5_000;
}
