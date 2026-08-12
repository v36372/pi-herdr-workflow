import { compute, defineWorkflow } from "pi-herdr-workflows";

/**
 * Level 1: pure compute chain. No agents, no shell.
 *
 * Input:  { value?: string | number }
 * Output: { original, normalized, length, summary }
 *
 * Run: /workflow 01-compute-pipeline
 *      /workflow 01-compute-pipeline {"value":"pi-herdr"}
 */
export default defineWorkflow({
  name: "01-compute-pipeline",
  title: ({ input }) => {
    const value = (input as { value?: unknown } | null)?.value;
    return value != null ? `compute-pipeline: ${String(value).slice(0, 40)}` : "compute-pipeline";
  },
  startAt: "normalize",
  presentationPrompt: "Show the normalized value, length, and one-line summary.",
  nodes: {
    normalize: compute({
      statusDetail: "Normalizing input",
      run: ({ input }) => {
        const raw =
          typeof input === "object" &&
          input !== null &&
          "value" in input &&
          (input as { value?: unknown }).value != null
            ? String((input as { value: unknown }).value)
            : "demo";
        return {
          original: raw,
          normalized: raw.trim().toLowerCase(),
        };
      },
    }),
    measure: compute({
      statusDetail: "Measuring length",
      run: ({ outputs }) => {
        const prior = outputs.normalize as { original: string; normalized: string };
        return {
          ...prior,
          length: prior.normalized.length,
        };
      },
    }),
    summarize: compute({
      statusDetail: "Building summary",
      run: ({ outputs }) => {
        const prior = outputs.measure as {
          original: string;
          normalized: string;
          length: number;
        };
        return {
          original: prior.original,
          normalized: prior.normalized,
          length: prior.length,
          summary: `"${prior.normalized}" (${prior.length} chars)`,
        };
      },
    }),
  },
  edges: [
    { from: "normalize", to: "measure" },
    { from: "measure", to: "summarize" },
  ],
});
