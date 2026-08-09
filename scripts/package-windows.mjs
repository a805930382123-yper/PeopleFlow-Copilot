import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(root, "release");
const stageRoot = path.join(releaseRoot, ".package-staging");
const target = path.join(stageRoot, "企业入职助手-最终版");
const zip = path.join(releaseRoot, "企业入职助手-最终版.zip");
if (!target.startsWith(releaseRoot)) throw new Error("Unexpected release target");

await rm(stageRoot, { recursive: true, force: true });
try { await rm(path.join(releaseRoot, "PeopleFlow-Local"), { recursive: true, force: true }); }
catch (error) { if (error?.code !== "EBUSY") throw error; console.warn("旧版 PeopleFlow-Local 正被窗口占用，已跳过清理；最终包不受影响。"); }
await rm(path.join(releaseRoot, "PeopleFlow-Local-Windows.zip"), { force: true });
await mkdir(target, { recursive: true });

const directories = ["data", "dist", "server", "scripts", "uploads"];
for (const directory of directories) {
  const source = path.join(root, directory);
  if (existsSync(source)) await cp(source, path.join(target, directory), { recursive: true });
}

const files = [".env.example", "启动企业入职助手.bat", "配置Coze Token.bat", "本地版使用说明.txt"];
for (const file of files) {
  const source = path.join(root, file);
  if (existsSync(source)) await cp(source, path.join(target, file));
}

for (const file of ["启动企业入职助手.bat", "配置Coze Token.bat"]) {
  const targetFile = path.join(target, file);
  const content = await readFile(targetFile, "utf8");
  await writeFile(targetFile, content.replace(/\r?\n/g, "\r\n"), "utf8");
}

await build({
  entryPoints: [path.join(root, "server", "index.mjs")],
  outfile: path.join(target, "server", "server-runtime.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@napi-rs/canvas"],
  logLevel: "warning",
});

await mkdir(path.join(target, "runtime"), { recursive: true });
await cp(process.execPath, path.join(target, "runtime", "node.exe"));
await writeFile(path.join(target, "版本.txt"), `企业入职助手 v1.6.0（RAG 知识库版）\n打包时间：${new Date().toISOString()}\n`, "utf8");

await rm(zip, { force: true });
const command = `Compress-Archive -LiteralPath '${target}' -DestinationPath '${zip}' -Force`;
const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { stdio: "inherit" });
if (result.status !== 0) throw new Error("Windows ZIP 打包失败");
await rm(stageRoot, { recursive: true, force: true });
console.log(`Windows package: ${zip}`);
