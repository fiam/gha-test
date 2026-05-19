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
  const sandboxEnabled = getBooleanInput("sandbox-enabled", false);
  const runnerHome = process.env.HOME || "";

  console.log("::group::GitHub Actions entrypoint probe pre-hook");
  console.log(`install docker wrapper: ${dockerEnabled}`);
  console.log(`setup unprivileged user: ${setupUser}`);
  console.log(`run entrypoints as user: ${runAsEnabled}`);
  console.log(`target user: ${runAsUser}`);
  console.log(`sandbox enabled: ${sandboxEnabled}`);
  console.log(`runner os: ${process.env.RUNNER_OS || ""}`);
  console.log(`home: ${process.env.HOME || ""}`);
  console.log(`workspace: ${process.env.GITHUB_WORKSPACE || ""}`);
  console.log(`runner temp: ${process.env.RUNNER_TEMP || ""}`);
  console.log(`docker path: ${DOCKER_PATH}`);
  console.log(`real docker path: ${REAL_DOCKER_PATH}`);

  if (sandboxEnabled && runAsEnabled) {
    throw new Error("sandbox-enabled and run-entrypoints-as-user are not supported together");
  }

  let identity = null;
  if (setupUser || runAsEnabled) {
    identity = ensureUnprivilegedUser(runAsUser);
    persistRunAsEnvironment(identity);
  }

  let sandbox = null;
  if (sandboxEnabled) {
    sandbox = setupSandbox();
    persistSandboxEnvironment(sandbox);
  }

  if (dockerEnabled) {
    installDockerWrapper(marker, runAsEnabled ? identity : null, sandbox);
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

function setupSandbox() {
  if (process.env.RUNNER_OS !== "Linux") {
    throw new Error("sbx sandbox setup is only implemented for Linux runners");
  }

  const installSbx = getBooleanInput("install-sbx-cli", true);
  const sbxVersion = getInput("sbx-deb-version", "v0.30.0");
  const dockerUsername = getInput("docker-username", "");
  const dockerPassword = getInput("docker-password", "");
  const networkPolicy = getInput("sandbox-network-policy", "balanced");
  const template = getInput("sandbox-template", "");
  const workRoot = resolveSandboxWorkRoot(getInput("sandbox-work-root", ""));
  const name = resolveSandboxName(getInput("sandbox-name", ""));
  const home = path.join(workRoot, "_temp", `${TOKEN}-sandbox-home`);

  console.log("::group::sbx sandbox setup");
  console.log(`install sbx cli: ${installSbx}`);
  console.log(`sbx deb version: ${sbxVersion}`);
  console.log(`sandbox name: ${name}`);
  console.log(`sandbox template: ${template || "(sbx shell default)"}`);
  console.log(`sandbox network policy: ${networkPolicy}`);
  console.log(`sandbox work root: ${workRoot}`);
  console.log(`sandbox home: ${home}`);
  console.log(`docker username available: ${dockerUsername ? "yes" : "no"}`);
  console.log(`docker password available: ${dockerPassword ? "yes" : "no"}`);

  if (installSbx) {
    ensureSbxCli(sbxVersion);
  } else {
    requireCommand("sbx");
    run("sbx", ["version"]);
  }

  authenticateSbx(dockerUsername, dockerPassword);
  grantKvmAccess();
  configureSbxPolicy(networkPolicy);

  fs.mkdirSync(workRoot, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  run("chmod", ["0777", home]);

  const createArgs = ["create", "--name", name];
  if (template) {
    createArgs.push("--template", template);
  }
  createArgs.push("shell", workRoot);
  run("sbx", createArgs);
  run("sbx", ["exec", "-w", workRoot, name, "sh", "-lc", "printf 'sandbox ready: '; pwd"]);

  appendState("sandbox_started", "true");
  appendState("sandbox_name", name);
  console.log("::endgroup::");

  return { name, workRoot, home };
}

function ensureSbxCli(version) {
  if (commandExists("sbx")) {
    console.log("sbx already installed:");
    run("sbx", ["version"]);
    return;
  }

  requireCommand("curl");
  requireCommand("dpkg");
  const arch = capture("dpkg", ["--print-architecture"]);
  const ubuntuVersion = capture("bash", [
    "-lc",
    ". /etc/os-release && printf '%s' \"${VERSION_ID//./}\"",
  ]);
  const asset = `DockerSandboxes-linux-${arch}-ubuntu${ubuntuVersion}.deb`;
  const url = `https://github.com/docker/sbx-releases/releases/download/${version}/${asset}`;
  const tempDir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), `${TOKEN}-sbx-`));
  const deb = path.join(tempDir, "sbx.deb");

  console.log(`downloading sbx backend: ${url}`);
  try {
    run("curl", ["-fsSL", "-o", deb, url]);
    run("sudo", ["apt-get", "update", "-qq"]);
    run("sudo", ["apt-get", "install", "-y", "--no-install-recommends", deb]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  run("sbx", ["version"]);
}

function authenticateSbx(username, password) {
  if (!username || !password) {
    console.log("docker credentials not provided; skipping docker/sbx login");
    return;
  }

  setDockerAuthConfig(username, password);

  if (commandExists("docker")) {
    runWithInput(
      "docker",
      ["login", "docker.io", "-u", username, "--password-stdin"],
      `${password}\n`,
      "docker login docker.io -u <docker-username> --password-stdin",
    );
    console.log(`docker CLI logged in to docker.io as ${username}`);
  } else {
    console.log("docker CLI is not present; skipping docker login");
  }

  try {
    runWithInput(
      "sbx",
      ["login", "--username", username, "--password-stdin"],
      `${password}\n`,
      "sbx login --username <docker-username> --password-stdin",
    );
    console.log(`sbx logged in to docker.io as ${username}`);
  } catch (error) {
    console.error(`::warning::sbx login failed; continuing with DOCKER_AUTH_CONFIG for this setup process: ${error.message}`);
  }
}

function setDockerAuthConfig(username, password) {
  const auth = Buffer.from(`${username}:${password}`).toString("base64");
  process.env.DOCKER_AUTH_CONFIG = JSON.stringify({
    auths: {
      "https://index.docker.io/v1/": { auth },
      "docker.io": { auth },
    },
  });
  console.log("prepared DOCKER_AUTH_CONFIG for sbx image pulls in this pre-hook process");
}

function grantKvmAccess() {
  if (!fs.existsSync("/dev/kvm")) {
    throw new Error("/dev/kvm is missing on this runner; sbx cannot start a sandbox");
  }

  run("sudo", ["groupadd", "-f", "kvm"]);
  run("sudo", ["usermod", "-aG", "kvm", capture("id", ["-un"])]);
  run("sudo", ["chmod", "0666", "/dev/kvm"]);
  run("ls", ["-l", "/dev/kvm"]);
}

function configureSbxPolicy(policy) {
  if (!["allow-all", "balanced", "deny-all"].includes(policy)) {
    throw new Error(
      `sandbox-network-policy must be allow-all, balanced, or deny-all; got ${policy}`,
    );
  }
  run("sbx", ["policy", "set-default", policy]);
}

function persistSandboxEnvironment(sandbox) {
  const values = {
    GHA_ENTRYPOINT_PROBE_SANDBOX_ENABLED: "true",
    GHA_ENTRYPOINT_PROBE_SANDBOX_NAME: sandbox.name,
    GHA_ENTRYPOINT_PROBE_SANDBOX_WORK_ROOT: sandbox.workRoot,
    GHA_ENTRYPOINT_PROBE_SANDBOX_HOME: sandbox.home,
  };

  for (const [name, value] of Object.entries(values)) {
    process.env[name] = value;
    appendEnv(name, value);
    console.log(`persist env ${name}=${value}`);
  }
}

function resolveSandboxWorkRoot(input) {
  if (input) {
    return path.resolve(input);
  }
  if (process.env.RUNNER_WORKSPACE) {
    return path.resolve(process.env.RUNNER_WORKSPACE, "..");
  }
  if (process.env.GITHUB_WORKSPACE) {
    return path.resolve(process.env.GITHUB_WORKSPACE);
  }
  return process.cwd();
}

function resolveSandboxName(input) {
  if (input) {
    return sanitizeSandboxName(input);
  }

  const runId = process.env.GITHUB_RUN_ID || "local";
  const attempt = process.env.GITHUB_RUN_ATTEMPT || "1";
  const job = process.env.GITHUB_JOB || "job";
  return sanitizeSandboxName(`gha-${runId}-${attempt}-${job}`);
}

function sanitizeSandboxName(name) {
  const sanitized = name.replace(/[^A-Za-z0-9.+-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw new Error(`sandbox name resolved to an empty value from ${name}`);
  }
  return sanitized.slice(0, 120);
}

function requireCommand(command) {
  if (!commandExists(command)) {
    throw new Error(`required command not found on PATH: ${command}`);
  }
}

function commandExists(command) {
  const result = childProcess.spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function installDockerWrapper(marker, identity, sandbox) {
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
    `sandbox_name=${quotePosix(sandbox ? sandbox.name : "")}`,
    `sandbox_home=${quotePosix(sandbox ? sandbox.home : "")}`,
    'shim_dir="${GHA_ENTRYPOINT_PROBE_SHIM_DIR:-}"',
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
    'sanitize_path_for_sandbox() {',
    '  local current_path="${PATH:-}"',
    '  local new_path=""',
    '  local old_ifs="$IFS"',
    '  IFS=:',
    '  for path_part in $current_path; do',
    '    if [ -n "$shim_dir" ] && [ "$path_part" = "$shim_dir" ]; then',
    "      continue",
    "    fi",
    '    if [ -z "$new_path" ]; then new_path="$path_part"; else new_path="$new_path:$path_part"; fi',
    "  done",
    '  IFS="$old_ifs"',
    '  printf "%s" "$new_path"',
    "}",
    'run_in_sandbox() {',
    '  if [ -z "$sandbox_name" ] || [ "${GHA_ENTRYPOINT_PROBE_SANDBOX_ACTIVE:-}" = "1" ]; then',
    '    return 1',
    "  fi",
    '  env_file="$(mktemp "${RUNNER_TEMP:-/tmp}/gha-entrypoint-probe-docker-env.XXXXXX")"',
    '  env | grep -v "^GHA_ENTRYPOINT_PROBE_WRAPPER_ACTIVE=" | grep -v "^GHA_ENTRYPOINT_PROBE_SANDBOX_ACTIVE=" | grep -v "^PATH=" | grep -v "^HOME=" > "$env_file"',
    '  printf "%s\\n" "GHA_ENTRYPOINT_PROBE_SANDBOX_ACTIVE=1" >> "$env_file"',
    '  printf "%s\\n" "PATH=$(sanitize_path_for_sandbox)" >> "$env_file"',
    '  if [ -n "$sandbox_home" ]; then printf "%s\\n" "HOME=$sandbox_home" >> "$env_file"; fi',
    '  sbx_args=("exec" "--env-file" "$env_file")',
    '  if [ -n "${PWD:-}" ]; then sbx_args+=("-w" "$PWD"); fi',
    '  sbx_args+=("$sandbox_name" "docker" "${args[@]}")',
    '  "$real" version >/dev/null 2>&1 || true',
    '  sbx "${sbx_args[@]}"',
    '  status=$?',
    '  rm -f "$env_file"',
    '  exit "$status"',
    "}",
    'printf "%s\\n" "$marker docker command: docker $*"',
    'run_in_sandbox || true',
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

function runWithInput(command, args, input, logCommand) {
  console.log(`exec: ${logCommand || `${command} ${args.join(" ")}`}`);
  const result = childProcess.spawnSync(command, args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(`${logCommand || `${command} ${args.join(" ")}`} exited ${result.status}`);
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
