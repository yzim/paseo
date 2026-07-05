#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const net = require("node:net");

async function main() {
  const appPath = readRequiredArg("--app");
  const absoluteAppPath = path.resolve(appPath);
  const resourcesDir = resolveResourcesDir(absoluteAppPath);
  const cliPath = resolveCliPath(resourcesDir);
  const appDistDir = path.join(resourcesDir, "app-dist");
  const indexHtmlPath = path.join(appDistDir, "index.html");

  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error(`Expected bundled web UI at ${indexHtmlPath}`);
  }

  const port = await getFreePort();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-packaged-cli-webui-"));
  const daemonLogPath = path.join(homeDir, "daemon.log");
  const child = spawnCli(cliPath, homeDir, port);

  try {
    await waitForHttpOk({ child, port });

    const daemonLog = fs.readFileSync(daemonLogPath, "utf8");
    if (!daemonLog.includes('"msg":"Daemon web UI mounted"')) {
      throw new Error(`Daemon log missing web UI mount entry:\n${daemonLog}`);
    }
    if (!daemonLog.includes('"distDir"') || !daemonLog.includes(`${path.sep}app-dist`)) {
      throw new Error(`Daemon log did not resolve app-dist:\n${daemonLog}`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          appPath: absoluteAppPath,
          cliPath,
          distDir: appDistDir,
          daemonLogPath,
          port,
        },
        null,
        2,
      ),
    );
  } finally {
    await terminateChild(child);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function readRequiredArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) {
    throw new Error(`Missing required argument ${flag}`);
  }
  return process.argv[index + 1];
}

function resolveResourcesDir(appPath) {
  if (process.platform === "darwin") {
    return path.join(appPath, "Contents", "Resources");
  }
  return path.join(appPath, "resources");
}

function resolveCliPath(resourcesDir) {
  if (process.platform === "win32") {
    const cliPath = path.join(resourcesDir, "bin", "paseo.cmd");
    if (!fs.existsSync(cliPath)) {
      throw new Error(`Bundled Windows CLI shim not found at ${cliPath}`);
    }
    return cliPath;
  }

  const cliPath = path.join(resourcesDir, "bin", "paseo");
  if (!fs.existsSync(cliPath)) {
    throw new Error(`Bundled CLI shim not found at ${cliPath}`);
  }
  return cliPath;
}

function spawnCli(cliPath, homeDir, port) {
  const args = [
    "daemon",
    "start",
    "--foreground",
    "--web-ui",
    "--no-relay",
    "--home",
    homeDir,
    "--port",
    String(port),
  ];

  const child = spawn(cliPath, args, {
    env: {
      ...process.env,
      PASEO_LOG_LEVEL: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.once("exit", (code, signal) => {
    if (code !== null || signal !== null) {
      child.__paseoExit = { code, signal, stdout, stderr };
    }
  });

  return child;
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a TCP port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHttpOk({ child, port }) {
  const deadline = Date.now() + 60_000;
  let lastError = null;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Packaged CLI exited before serving the web UI`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      const body = await response.text();
      if (response.ok && body.includes("<!DOCTYPE html")) {
        return;
      }
      throw new Error(`Unexpected response ${response.status}: ${body.slice(0, 400)}`);
    } catch (error) {
      lastError = error;
      if (isConnectionError(error)) {
        await delay(1_000);
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Timed out waiting for packaged CLI web UI: ${lastError}`);
}

function isConnectionError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  return /ECONNREFUSED|fetch failed|UND_ERR_CONNECT_TIMEOUT|EADDRNOTAVAIL/i.test(error.message);
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const shutdown = new Promise((resolve) => {
    child.once("exit", () => resolve());
  });

  child.kill("SIGINT");
  await Promise.race([shutdown, delay(10_000)]);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await shutdown;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
