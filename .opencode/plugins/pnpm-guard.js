export const PnpmGuard = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash" && typeof output.args?.command === "string") {
        const cmd = output.args.command;
        // Block npm/yarn package-manager use, but allow npx (MCP servers run via npx).
        if (/(^|[\s;&|])(npm(\s|$)|yarn(\s|$)|pnpm dlx)/.test(cmd)) {
          throw new Error(
            "Blocked: use pnpm, never npm/yarn (AGENTS.md §1). npx -y is allowed for MCP servers only."
          );
        }
      }
    },
  };
};
