// Makes dist/cli.js executable (tsc keeps the shebang but not the mode) for `npm link` and local runs.
import { chmod } from "node:fs/promises";

await chmod(new URL("../dist/cli.js", import.meta.url), 0o755);
