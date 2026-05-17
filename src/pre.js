const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const TOKEN = "gha-entrypoint-probe";
const DOCKER_PATH = "/usr/bin/docker";
const REAL_DOCKER_PATH = "/usr/bin/docker.gha-entrypoint-probe-real";

function main() {
  const marker = getInput("marker", "[gha-entrypoint-probe] before");
  const enabled = getBooleanInput("install-docker-wrapper", true);

  console.log("::group::GitHub Actions entrypoint probe pre-hook");
  console.log(`install docker wrapper: ${enabled}`);
  console.log(`runner os: ${process.env.RUNNER_OS || ""}`);
  console.log(`docker path: ${DOCKER_PATH}`);
  console.log(`real docker path: ${REAL_DOCKER_PATH}`);

  if (!enabled) {
    console.log("docker wrapper disabled by input");
    console.log("::endgroup::");
    return;
  }

  if (process.env.RUNNER_OS !== "Linux") {
    console.log("docker wrapper only attempted on Linux runners");
    console.log("::endgroup::");
    return;
  }

  if (!fs.existsSync(DOCKER_PATH)) {
    console.error(`${DOCKER_PATH} does not exist; cannot install docker wrapper`);
    console.log("::endgroup::");
    return;
  }

  if (fs.existsSync(REAL_DOCKER_PATH)) {
    console.log("docker wrapper already appears to be installed");
    appendState("docker_wrapper_installed", "true");
    console.log("::endgroup::");
    return;
  }

  const wrapper = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `real=${quotePosix(REAL_DOCKER_PATH)}`,
    `marker=${quotePosix(marker)}`,
    'subcommand="${1:-}"',
    'printf "%s\\n" "$marker docker command: docker $*"',
    'if [ "$subcommand" = "run" ]; then',
    '  printf "%s\\n" "$marker docker run intercepted"',
    "fi",
    'exec "$real" "$@"',
    "",
  ].join("\n");

  const tempWrapper = path.join(
    process.env.RUNNER_TEMP || os.tmpdir(),
    `${TOKEN}-docker-wrapper-${process.pid}`,
  );
  fs.writeFileSync(tempWrapper, wrapper, { mode: 0o755 });
  console.log(`wrote temporary wrapper: ${tempWrapper}`);

  run("sudo", ["mv", DOCKER_PATH, REAL_DOCKER_PATH]);
  run("sudo", ["install", "-m", "0755", tempWrapper, DOCKER_PATH]);

  appendState("docker_wrapper_installed", "true");
  console.log("installed docker wrapper");
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

function getInput(name, fallback) {
  const candidates = unique([
    `INPUT_${name.replace(/ /g, "_").toUpperCase()}`,
    `INPUT_${name.replace(/[ -]/g, "_").toUpperCase()}`,
  ]);

  for (const key of candidates) {
    const value = process.env[key];
    if (value != null && value !== "") {
      return value;
    }
  }

  return fallback;
}

function getBooleanInput(name, fallback) {
  const value = getInput(name, String(fallback)).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function appendState(name, value) {
  const file = process.env.GITHUB_STATE;
  if (!file) {
    console.error(`GITHUB_STATE is not set; unable to persist ${name}`);
    return;
  }

  fs.appendFileSync(file, `${name}=${value}${os.EOL}`);
}

function quotePosix(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function unique(values) {
  return [...new Set(values)];
}

try {
  main();
} catch (error) {
  console.log(`::error::${error.stack || error.message}`);
  process.exitCode = 1;
}
