import { compute, defineWorkflow, shell } from "pi-herdr-workflows";

/**
 * Shell facts, then reshape. No agent pane.
 *
 * Run: /workflow shell-stats
 */
export default defineWorkflow({
  name: "shell-stats",
  title: "shell-stats",
  startAt: "listFiles",
  presentationPrompt: "Show cwd, file count, and a few sample paths.",
  nodes: {
    listFiles: shell({
      statusDetail: "Listing top-level files",
      exec: () => ({
        command: "bash",
        args: ["-lc", "find . -maxdepth 1 -type f -print | sort"],
        cwd: process.cwd(),
      }),
      parse: (result) => {
        const files = result.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        return { files, exitCode: result.exitCode };
      },
    }),
    countLines: shell({
      statusDetail: "Counting TypeScript lines",
      exec: () => ({
        command: "bash",
        args: [
          "-lc",
          "find src -name '*.ts' -print0 2>/dev/null | xargs -0 wc -l 2>/dev/null | tail -n 1",
        ],
        cwd: process.cwd(),
        allowNonZeroExit: true,
      }),
      parse: (result) => {
        const match = result.stdout.trim().match(/(\d+)/);
        return {
          lineCount: match ? Number(match[1]) : null,
          raw: result.stdout.trim(),
        };
      },
    }),
    summarize: compute({
      statusDetail: "Shaping final stats",
      run: ({ outputs }) => {
        const listed = outputs.listFiles as { files: string[] };
        const counted = outputs.countLines as { lineCount: number | null };
        return {
          cwd: process.cwd(),
          files: listed.files,
          fileCount: listed.files.length,
          lineCount: counted.lineCount,
          sample: listed.files.slice(0, 5),
        };
      },
    }),
  },
  edges: [
    { from: "listFiles", to: "countLines" },
    { from: "countLines", to: "summarize" },
  ],
});
