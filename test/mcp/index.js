import { execFileSync } from "node:child_process";

execFileSync("pnpm", ["exec", "tsc"], { stdio: "ignore" });
await import("./server.test.ts");
