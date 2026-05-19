const fs = require("fs");
const childProcess = require("child_process");

const DOCKER_PATH = "/usr/bin/docker";
const REAL_DOCKER_PATH = "/usr/bin/docker.gha-entrypoint-probe-real";

function main() {
  console.log("::group::GitHub Actions entrypoint probe post-hook");
  console.log(`state docker wrapper installed: ${process.env.STATE_docker_wrapper_installed || ""}`);
  console.log(`state sandbox started: ${process.env.STATE_sandbox_started || ""}`);
  console.log(`state sandbox name: ${process.env.STATE_sandbox_name || ""}`);

  if (process.env.RUNNER_OS === "Linux") {
    restoreDockerWrapper();
  } else {
    console.log("docker wrapper restore only applies to Linux runners");
  }

  removeSandbox();
  console.log("::endgroup::");
}

function restoreDockerWrapper() {
  if (!fs.existsSync(REAL_DOCKER_PATH)) {
    console.log("real docker backup not found; nothing to restore");
    return;
  }

  run("sudo", ["rm", "-f", DOCKER_PATH]);
  run("sudo", ["mv", REAL_DOCKER_PATH, DOCKER_PATH]);
  console.log("restored original docker binary");
}

function removeSandbox() {
  const name = process.env.STATE_sandbox_name || process.env.GHA_ENTRYPOINT_PROBE_SANDBOX_NAME || "";
  if (!name) {
    console.log("sandbox name not recorded; nothing to remove");
    return;
  }

  if (!commandExists("sbx")) {
    console.log("sbx is not on PATH; unable to remove sandbox");
    return;
  }

  run("sbx", ["rm", "--force", name]);
  console.log(`removed sandbox: ${name}`);
}

function run(command, args) {
  console.log(`exec: ${command} ${args.join(" ")}`);
  const result = childProcess.spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
}

function commandExists(command) {
  const result = childProcess.spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

try {
  main();
} catch (error) {
  console.log(`::error::${error.stack || error.message}`);
  process.exitCode = 1;
}
