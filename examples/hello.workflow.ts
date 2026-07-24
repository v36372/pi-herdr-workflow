import { compute, defineWorkflow } from "pi-herdr-workflows";

/**
 * Pure compute. No model, no shell, no Herdr pane.
 *
 * Input:  { name?: string }
 * Output: { greeting: string, at: string }
 *
 * Run: /workflow hello
 *      /workflow hello {"name":"tin"}
 */
export default defineWorkflow({
  name: "hello",
  title: ({ input }) => {
    const name = (input as { name?: string } | null)?.name;
    return name ? `hello: ${name}` : "hello";
  },
  startAt: "greet",
  presentationPrompt: "Present the greeting and timestamp in one short line.",
  nodes: {
    greet: compute({
      statusDetail: "Building greeting",
      run: ({ input }) => {
        const name =
          typeof input === "object" &&
          input !== null &&
          "name" in input &&
          typeof (input as { name?: unknown }).name === "string"
            ? (input as { name: string }).name.trim()
            : "world";
        return {
          greeting: `hello, ${name || "world"}`,
          at: new Date().toISOString(),
        };
      },
    }),
  },
  edges: [],
});
