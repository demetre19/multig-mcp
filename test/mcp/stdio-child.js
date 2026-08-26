import { serve } from "../../dist/mcp/server.js";

await serve({
  async listAccounts() {
    process.stderr.write("synthetic MCP diagnostic\n");
    return [{ alias: "synthetic", email: "synthetic@example.test", scopes: ["scope"], status: "connected" }];
  },
  async openSession(alias) {
    throw new Error(`not used for ${alias}`);
  },
});
