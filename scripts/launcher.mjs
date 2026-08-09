import { spawn } from "node:child_process";

const port = Number(process.env.PORT || 3188);
const apiPort = Number(process.env.API_PORT || 8787);
const localUrl = `http://127.0.0.1:${port}`;

async function isPeopleFlowOnline() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(localUrl, { signal: controller.signal });
    return response.ok && (await response.text()).includes("PeopleFlow");
  } catch { return false; }
  finally { clearTimeout(timer); }
}

async function reloadRuntimeEnvironment() {
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/system/reload-env`, { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}

function openBrowser() {
  if (process.env.AUTO_OPEN === "0") return;
  if (process.platform === "win32") {
    const opener = spawn("cmd.exe", ["/d", "/c", "start", "", localUrl], { detached: true, stdio: "ignore", windowsHide: true });
    opener.unref();
  }
}

if (await isPeopleFlowOnline()) {
  await reloadRuntimeEnvironment();
  console.log(`PeopleFlow is already running: ${localUrl}`);
  openBrowser();
} else {
  process.env.AUTO_OPEN ??= "1";
  await import("./portable.mjs");
}
