export const EnvProtection = async () => {
  const blocked = [".env", "tokens.json", "token_refresh.lock", "sync_state.json"];
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "read" && typeof output.args?.filePath === "string") {
        const fp = output.args.filePath;
        if (blocked.some((b) => fp.includes(b))) {
          throw new Error(
            `Blocked: do not read ${fp} — secrets stay in OS keyring / IndexedDB, never in prompts (AGENTS.md §5).`
          );
        }
      }
    },
  };
};
