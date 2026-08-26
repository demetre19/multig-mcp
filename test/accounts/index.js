import { register } from "node:module";

register("../auth/source-loader.mjs", import.meta.url);
await import("./sessions.test.ts");
