import { register } from "node:module";

register("./source-loader.mjs", import.meta.url);
await import("./lifecycle.test.ts");
