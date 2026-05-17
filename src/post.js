const fs = require("fs");
const childProcess = require("child_process");

const DOCKER_PATH = "/usr/bin/docker";
const REAL_DOCKER_PATH = "/usr/bin/docker.gha-entrypoint-probe-real";

function main() {
  console.log("::group::GitHub Actions entrypoint probe post-hook");
  console.log(`state docker wrapper installed: ${process.env.STATE_docker_wrapper_installed || ""}`);

  if (process.env.RUNNER_OS !== "Linux") {
    console.log("docker wrapper restore only applies to Linux runners");
    console.log("::endgroup::");
    return;
  }

  if (!fs.existsSync(REAL_DOCKER_PATH)) {
    console.log("real docker backup not found; nothing to restore");
    console.log("::endgroup::");
    return;
  }

  run("sudo", ["rm", "-f", DOCKER_PATH]);
  run("sudo", ["mv", REAL_DOCKER_PATH, DOCKER_PATH]);
  console.log("restored original docker binary");
  console.log("::endgroup::");
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

try {
  main();
} catch (error) {
  console.log(`::error::${error.stack || error.message}`);
  process.exitCode = 1;
}
