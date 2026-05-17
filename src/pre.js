const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const TOKEN = "gha-entrypoint-probe";
const DOCKER_PATH = "/usr/bin/docker";
const REAL_DOCKER_PATH = "/usr/bin/docker.gha-entrypoint-probe-real";

function main() {
  const marker = getInput("marker", "[gha-entrypoint-probe] before");
  const dockerEnabled = getBooleanInput("install-docker-wrapper", true);
  const setupUser = getBooleanInput("setup-unprivileged-user", false);
  const runAsEnabled = getBooleanInput("run-entrypoints-as-user", false);
  const runAsUser = getInput("run-as-user", "unpriv");
  const runnerHome = process.env.HOME || "";

  console.log("::group::GitHub Actions entrypoint probe pre-hook");
  console.log(`install docker wrapper: ${dockerEnabled}`);
  console.log(`setup unprivileged user: ${setupUser}`);
  console.log(`run entrypoints as user: ${runAsEnabled}`);
  console.log(`target user: ${runAsUser}`);
  console.log(`runner os: ${process.env.RUNNER_OS || ""}`);
  console.log(`home: ${process.env.HOME || ""}`);
  console.log(`workspace: ${process.env.GITHUB_WORKSPACE || ""}`);
  console.log(`runner temp: ${process.env.RUNNER_TEMP || ""}`);
  console.log(`docker path: ${DOCKER_PATH}`);
  console.log(`real docker path: ${REAL_DOCKER_PATH}`);

  let identity = null;
  if (setupUser || runAsEnabled) {
    identity = ensureUnprivilegedUser(runAsUser);
    persistRunAsEnvironment(identity);
  }

  if (dockerEnabled) {
    installDockerWrapper(marker, runAsEnabled ? identity : null);
  } else {
    console.log("docker wrapper disabled by input");
  }

  if (runAsEnabled) {
    runScannerEarly();
    chownRuntimePaths(identity, runnerHome);
    appendEnv("GHA_ENTRYPOINT_PROBE_PRE_RAN", "true");
  }

  console.log("::endgroup::");
}

function ensureUnprivilegedUser(user) {
  if (process.env.RUNNER_OS !== "Linux") {
    throw new Error("unprivileged user setup is only implemented for Linux runners");
  }

  if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(user)) {
    throw new Error(`refusing invalid run-as-user value: ${user}`);
  }

  const existing = childProcess.spawnSync("id", ["-u", user], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (existing.status === 0) {
    console.log(`user already exists: ${user} uid=${existing.stdout.trim()}`);
  } else {
    console.log(`creating unprivileged user: ${user}`);
    run("sudo", ["useradd", "--create-home", "--shell", "/usr/bin/bash", user]);
  }

  if (groupExists("docker")) {
    console.log(`adding ${user} to docker group`);
    run("sudo", ["usermod", "-aG", "docker", user]);
  } else {
    console.log("docker group not present; not adding target user to docker group");
  }

  const runnerGroup = capture("id", ["-gn"]);
  console.log(`adding ${user} to runner group: ${runnerGroup}`);
  run("sudo", ["usermod", "-aG", runnerGroup, user]);

  const uid = capture("id", ["-u", user]);
  const gid = capture("id", ["-g", user]);
  const runnerGid = capture("id", ["-g"]);
  const home = capture("getent", ["passwd", user]).split(":")[5] || "";
  console.log(
    `target identity: user=${user} uid=${uid} gid=${gid} runner_group=${runnerGroup} runner_gid=${runnerGid} passwd_home=${home}`,
  );
  return { user, uid, gid, home, runnerGroup, runnerGid };
}

function persistRunAsEnvironment(identity) {
  const values = {
    GHA_ENTRYPOINT_PROBE_UNPRIV_USER: identity.user,
    GHA_ENTRYPOINT_PROBE_UNPRIV_UID: identity.uid,
    GHA_ENTRYPOINT_PROBE_UNPRIV_GID: identity.gid,
    GHA_ENTRYPOINT_PROBE_UNPRIV_HOME: identity.home,
    HOME: identity.home,
  };

  for (const [name, value] of Object.entries(values)) {
    process.env[name] = value;
    appendEnv(name, value);
    console.log(`persist env ${name}=${value}`);
  }
}

function installDockerWrapper(marker, identity) {
  if (process.env.RUNNER_OS !== "Linux") {
    console.log("docker wrapper only attempted on Linux runners");
    return;
  }

  if (!fs.existsSync(DOCKER_PATH)) {
    console.error(`${DOCKER_PATH} does not exist; cannot install docker wrapper`);
    return;
  }

  if (fs.existsSync(REAL_DOCKER_PATH)) {
    console.log("docker wrapper already appears to be installed");
    appendState("docker_wrapper_installed", "true");
    return;
  }

  const wrapper = [
    "#!/usr/bin/bash",
    "set -euo pipefail",
    `real=${quotePosix(REAL_DOCKER_PATH)}`,
    `marker=${quotePosix(marker)}`,
    `run_as_user=${quotePosix(identity ? identity.user : "")}`,
    `run_as_uid=${quotePosix(identity ? identity.uid : "")}`,
    `run_as_gid=${quotePosix(identity ? identity.gid : "")}`,
    'subcommand="${1:-}"',
    'args=("$@")',
    'prepare_file_commands() {',
    '  for dir in "${RUNNER_TEMP:-}/_runner_file_commands" "${RUNNER_TEMP:-}/_github_home" "${RUNNER_TEMP:-}/_github_workflow"; do',
    '    if [ -n "$dir" ] && [ -d "$dir" ]; then',
    '      sudo chmod -R a+rwX "$dir" 2>/dev/null || chmod -R a+rwX "$dir" 2>/dev/null || true',
    "    fi",
    "  done",
    '  for file in "${GITHUB_ENV:-}" "${GITHUB_OUTPUT:-}" "${GITHUB_PATH:-}" "${GITHUB_STATE:-}" "${GITHUB_STEP_SUMMARY:-}"; do',
    '    if [ -n "$file" ] && [ -e "$file" ]; then',
    '      sudo chmod a+rw "$file" 2>/dev/null || chmod a+rw "$file" 2>/dev/null || true',
    "    fi",
    "  done",
    "}",
    'printf "%s\\n" "$marker docker command: docker $*"',
    'if [ "$subcommand" = "run" ]; then',
    '  printf "%s\\n" "$marker docker run intercepted"',
    '  if [ -n "$run_as_uid" ] && [ -n "$run_as_gid" ]; then',
    "    has_user=0",
    '    for arg in "${args[@]}"; do',
    '      case "$arg" in',
    '        --user|-u|--user=*) has_user=1 ;;',
    "      esac",
    "    done",
    '    if [ "$has_user" = "0" ]; then',
    "      prepare_file_commands",
    '      printf "%s\\n" "$marker docker run injecting --user ${run_as_uid}:${run_as_gid} (${run_as_user})"',
    '      args=("run" "--user" "${run_as_uid}:${run_as_gid}" "${args[@]:1}")',
    "    else",
    '      printf "%s\\n" "$marker docker run already has a user flag; not injecting one"',
    "    fi",
    "  fi",
    "fi",
    'exec "$real" "${args[@]}"',
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
}

function runScannerEarly() {
  const scanner = path.join(__dirname, "index.js");
  console.log(`running scanner early from pre-hook: ${scanner}`);
  const env = {
    ...process.env,
    GHA_ENTRYPOINT_PROBE_RUNNING_IN_PRE: "true",
  };
  const result = childProcess.spawnSync(process.execPath, [scanner], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(`early scanner exited ${result.status}`);
  }
}

function chownRuntimePaths(identity, runnerHome) {
  prepareUnprivilegedHome(identity);
  prepareRunnerHomeTraversal(identity, runnerHome);
  prepareRunnerWorkTree(identity, runnerHome);
}

function prepareUnprivilegedHome(identity) {
  if (!identity.home) {
    console.log("target user home is empty; skipping home ownership change");
    return;
  }
  const resolved = path.resolve(identity.home);

  if (!fs.existsSync(resolved)) {
    console.log(`creating target user home: ${resolved}`);
    run("sudo", ["mkdir", "-p", resolved]);
  }

  if (resolved === "/" || resolved.length < 5) {
    throw new Error(`refusing unsafe ownership path: ${resolved}`);
  }

  console.log(`changing target home ownership to ${identity.uid}:${identity.gid}: ${resolved}`);
  run("sudo", ["chown", "-R", `${identity.uid}:${identity.gid}`, resolved]);
  run("sudo", ["chmod", "755", resolved]);
  run("stat", ["-c", "%U:%G %a %n", resolved]);

  for (const child of [".cache", ".config", ".local", ".npm"]) {
    const target = path.join(resolved, child);
    if (!fs.existsSync(target)) {
      run("sudo", ["mkdir", "-p", target]);
    }
    console.log(`preparing home child for ${identity.user}: ${target}`);
    run("sudo", ["chown", "-R", `${identity.uid}:${identity.gid}`, target]);
  }
}

function prepareRunnerHomeTraversal(identity, runnerHome) {
  if (!runnerHome) {
    console.log("runner HOME was empty; skipping runner home traversal setup");
    return;
  }
  const resolved = safePath(runnerHome);
  if (!resolved || resolved === path.resolve(identity.home || "")) {
    return;
  }

  console.log(`allowing ${identity.user} to traverse runner home for downloaded actions: ${resolved}`);
  run("sudo", ["chmod", "755", resolved]);
  run("stat", ["-c", "%U:%G %a %n", resolved]);
}

function prepareRunnerWorkTree(identity, runnerHome) {
  if (!runnerHome) {
    console.log("runner HOME was empty; skipping work tree ownership change");
    return;
  }
  const resolved = safePath(path.join(runnerHome, "work"));
  if (!resolved) {
    return;
  }

  console.log(
    `changing runner work tree ownership to ${identity.uid}:${identity.runnerGid}: ${resolved}`,
  );
  run("sudo", ["chown", "-R", `${identity.uid}:${identity.runnerGid}`, resolved]);
  run("sudo", ["chmod", "-R", "u+rwX,g+rwX", resolved]);
  run("stat", ["-c", "%U:%G %a %n", resolved]);
}

function safePath(candidate) {
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved)) {
    console.log(`skip ownership change for missing path: ${resolved}`);
    return "";
  }
  if (resolved === "/" || resolved.length < 5) {
    throw new Error(`refusing unsafe ownership path: ${resolved}`);
  }
  return resolved;
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

function capture(command, args) {
  const result = childProcess.spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
  return result.stdout.trim();
}

function groupExists(name) {
  const result = childProcess.spawnSync("getent", ["group", name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
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

function appendEnv(name, value) {
  const file = process.env.GITHUB_ENV;
  if (!file) {
    console.error(`GITHUB_ENV is not set; unable to persist ${name}`);
    return;
  }

  fs.appendFileSync(file, `${name}=${value}${os.EOL}`);
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
