import { execFileSync } from "node:child_process";

execFileSync("pnpm", ["exec", "tsc"], { stdio: "ignore" });
await import("./mime.test.ts");
await import("./client.test.ts");
