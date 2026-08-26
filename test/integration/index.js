import { execFileSync } from "node:child_process";

execFileSync("pnpm", ["exec", "tsc"], { stdio: "ignore" });
await import("./integration.test.ts");
