import { compute, defineWorkflow, shell } from "pi-herdr-workflows";

/**
 * Level 2: deterministic shell → compute. No agents.
 *
 * Input:  { label?: string }
 * Output: { label, fact, formatted }
 *
 * Run: /workflow 02-shell-facts
 *      /workflow 02-shell-facts {"label":"build"}
 */
export default defineWorkflow({
  name: "02-shell-facts",
  title: ({ input }) => {
    const label = (input as { label?: string } | null)?.label;
    return label ? `shell-facts: ${label}` : "shell-facts";
  },
  startAt: "emitFact",
  presentationPrompt: "Show the shell fact and the formatted line.",
  nodes: {
    emitFact: shell({
      statusDetail: "Emitting a deterministic fact",
      exec: () => ({
        command: "node",
        args: ["-e", "process.stdout.write(JSON.stringify({ fact: 'shell-ok', n: 2 + 2 }))"],
        cwd: process.cwd(),
      }),
      parse: (result) => {
        const parsed = JSON.parse(result.stdout) as { fact: string; n: number };
        return {
          fact: parsed.fact,
          n: parsed.n,
          exitCode: result.exitCode,
        };
      },
    }),
    format: compute({
      statusDetail: "Formatting shell fact",
      run: ({ input, outputs }) => {
        const label =
          typeof input === "object" &&
          input !== null &&
          typeof (input as { label?: unknown }).label === "string"
            ? (input as { label: string }).label.trim() || "demo"
            : "demo";
        const shellOut = outputs.emitFact as { fact: string; n: number; exitCode: number | null };
        return {
          label,
          fact: shellOut.fact,
          n: shellOut.n,
          formatted: `[${label}] ${shellOut.fact} (n=${shellOut.n})`,
        };
      },
    }),
  },
  edges: [{ from: "emitFact", to: "format" }],
});
