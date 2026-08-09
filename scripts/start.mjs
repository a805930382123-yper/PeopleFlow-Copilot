import { spawn } from "node:child_process";
const api = spawn(process.execPath, ["--env-file-if-exists=.env", "server/index.mjs"], { stdio: "inherit", env: process.env });
const web = spawn(process.execPath, ["node_modules/vinext/dist/cli.js", "start"], { stdio: "inherit", env: process.env });
const stop = () => { api.kill(); web.kill(); process.exit(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
