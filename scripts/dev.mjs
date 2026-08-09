import { spawn } from "node:child_process";

const env = { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" };
const api = spawn(process.execPath, ["--env-file-if-exists=.env", "server/index.mjs"], { stdio: "inherit", env });
const web = spawn(process.execPath, ["node_modules/vinext/dist/cli.js", "dev"], { stdio: "inherit", env });
const stop = () => { api.kill(); web.kill(); process.exit(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
api.on("exit", (code) => { if (code) { web.kill(); process.exit(code); } });
web.on("exit", (code) => { api.kill(); process.exit(code || 0); });
