const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");

const TOKEN = "gha-entrypoint-probe";

async function main() {
  if (
    process.env.GHA_ENTRYPOINT_PROBE_PRE_RAN === "true" &&
    process.env.GHA_ENTRYPOINT_PROBE_RUNNING_IN_PRE !== "true"
  ) {
    console.log("::group::GitHub Actions entrypoint probe");
    console.log("scanner already ran from the action pre-hook; skipping duplicate main pass");
    console.log("::endgroup::");
    return;
  }

  const workspace = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const runnerWorkspace = path.resolve(
    process.env.RUNNER_WORKSPACE || path.dirname(workspace),
  );
  const actionRepoRoot = path.resolve(__dirname, "..");
  const actionCacheRoots = getActionCacheRoots(workspace, runnerWorkspace);
  const currentAction = getCurrentActionIdentity(actionRepoRoot);
  const marker = getInput("marker", "[gha-entrypoint-probe] before");
  const githubToken = getInput("github-token", process.env.GITHUB_TOKEN || "");
  const options = {
    workspace,
    runnerWorkspace,
    actionRepoRoot,
    actionCacheRoots,
    currentAction,
    repoRoots: unique([workspace, actionRepoRoot]).filter((candidate) =>
      fs.existsSync(candidate),
    ),
    marker,
    githubToken,
    installShellShims: getBooleanInput("install-shell-shims", true),
    patchWorkspace: getBooleanInput("patch-workspace", true),
    patchDownloadedActions: getBooleanInput("patch-downloaded-actions", true),
    sandboxEnabled:
      getBooleanInput("sandbox-enabled", false) ||
      process.env.GHA_ENTRYPOINT_PROBE_SANDBOX_ENABLED === "true",
    sandboxName: process.env.GHA_ENTRYPOINT_PROBE_SANDBOX_NAME || "",
    sandboxWorkRoot: process.env.GHA_ENTRYPOINT_PROBE_SANDBOX_WORK_ROOT || "",
    sandboxHome: process.env.GHA_ENTRYPOINT_PROBE_SANDBOX_HOME || "",
    runEntrypointsAsUser: getBooleanInput("run-entrypoints-as-user", false),
    runAsUser: getInput("run-as-user", "unpriv"),
    runAsUid: process.env.GHA_ENTRYPOINT_PROBE_UNPRIV_UID || "",
    runAsGid: process.env.GHA_ENTRYPOINT_PROBE_UNPRIV_GID || "",
    runAsHome: process.env.GHA_ENTRYPOINT_PROBE_UNPRIV_HOME || "",
    visitedActions: new Set(),
    visitedWorkflows: new Set(),
    queuedActions: [],
    queuedWorkflows: [],
    patchedFiles: new Set(),
    skipped: [],
    stats: {
      workflowsScanned: 0,
      actionsScanned: 0,
      runEntrypointsPatched: 0,
      nodeEntrypointsPatched: 0,
      shellEntrypointsPatched: 0,
      localUsesResolved: 0,
      externalUsesResolved: 0,
      externalUsesMissing: 0,
      shellShimsInstalled: 0,
    },
  };

  console.log("::group::GitHub Actions entrypoint probe");
  logEnvironment(options);

  if (options.installShellShims) {
    installShellInstrumentation(options);
  }

  if (options.patchWorkspace) {
    enqueueWorkspaceWorkflows(options);
    await enqueueCurrentWorkflowFromApi(options);
    enqueueActionIfPresent(options, workspace);
  }

  if (options.patchDownloadedActions) {
    enqueueDownloadedActions(options);
  }

  drainQueues(options);

  console.log("summary:");
  console.log(`  workflows scanned: ${options.stats.workflowsScanned}`);
  console.log(`  actions scanned: ${options.stats.actionsScanned}`);
  console.log(`  run entrypoints patched: ${options.stats.runEntrypointsPatched}`);
  console.log(`  node entrypoints patched: ${options.stats.nodeEntrypointsPatched}`);
  console.log(`  shell entrypoints patched: ${options.stats.shellEntrypointsPatched}`);
  console.log(`  local uses resolved: ${options.stats.localUsesResolved}`);
  console.log(`  external uses resolved: ${options.stats.externalUsesResolved}`);
  console.log(`  external uses missing: ${options.stats.externalUsesMissing}`);
  console.log(`  shell shims installed: ${options.stats.shellShimsInstalled}`);
  console.log(`patched files: ${options.patchedFiles.size}`);
  for (const file of [...options.patchedFiles].sort()) {
    console.log(`patched: ${relativeForLog(file, workspace)}`);
  }
  for (const skip of options.skipped) {
    console.log(`skipped: ${skip}`);
  }
  console.log("::endgroup::");
}

function logEnvironment(options) {
  console.log("environment:");
  console.log(`  cwd: ${process.cwd()}`);
  console.log(`  node: ${process.version}`);
  console.log(`  platform: ${process.platform} ${process.arch}`);
  console.log(`  workspace: ${options.workspace}`);
  console.log(`  runner workspace: ${options.runnerWorkspace}`);
  console.log(`  action repo root: ${options.actionRepoRoot}`);
  console.log(
    `  current action identity: ${options.currentAction ? `${options.currentAction.owner}/${options.currentAction.repo}@${options.currentAction.ref}` : "(unknown)"}`,
  );
  console.log(`  runner temp: ${process.env.RUNNER_TEMP || ""}`);
  console.log(`  runner os: ${process.env.RUNNER_OS || ""}`);
  console.log(`  github repository: ${process.env.GITHUB_REPOSITORY || ""}`);
  console.log(`  github ref: ${process.env.GITHUB_REF || ""}`);
  console.log(`  github sha: ${process.env.GITHUB_SHA || ""}`);
  console.log(`  github workflow: ${process.env.GITHUB_WORKFLOW || ""}`);
  console.log(`  github workflow ref: ${process.env.GITHUB_WORKFLOW_REF || ""}`);
  console.log(`  github action path: ${process.env.GITHUB_ACTION_PATH || ""}`);
  console.log(`  marker: ${options.marker}`);
  console.log(`  install shell shims: ${options.installShellShims}`);
  console.log(`  patch workspace: ${options.patchWorkspace}`);
  console.log(`  patch downloaded actions: ${options.patchDownloadedActions}`);
  console.log(`  sandbox enabled: ${options.sandboxEnabled}`);
  console.log(`  sandbox name: ${options.sandboxName || "(unset)"}`);
  console.log(`  sandbox work root: ${options.sandboxWorkRoot || "(unset)"}`);
  console.log(`  sandbox home: ${options.sandboxHome || "(unset)"}`);
  console.log(`  run entrypoints as user: ${options.runEntrypointsAsUser}`);
  console.log(`  run-as user: ${options.runAsUser}`);
  console.log(`  run-as uid: ${options.runAsUid || "(unset)"}`);
  console.log(`  run-as gid: ${options.runAsGid || "(unset)"}`);
  console.log(`  run-as home: ${options.runAsHome || "(unset)"}`);
  console.log(`  running in pre-hook: ${process.env.GHA_ENTRYPOINT_PROBE_RUNNING_IN_PRE || "false"}`);
  console.log(`  github token available: ${options.githubToken ? "yes" : "no"}`);
  console.log("  action cache roots:");
  for (const actionCacheRoot of options.actionCacheRoots) {
    console.log(`    ${actionCacheRoot}`);
  }
  console.log("  repository roots used for local references:");
  for (const repoRoot of options.repoRoots) {
    console.log(`    ${repoRoot}`);
  }
  console.log("  PATH entries:");
  for (const entry of (process.env.PATH || "").split(path.delimiter)) {
    console.log(`    ${entry}`);
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

function enqueueWorkspaceWorkflows(options) {
  const workflowDir = path.join(options.workspace, ".github", "workflows");
  console.log(`scanning workspace workflows under ${workflowDir}`);
  for (const file of listFiles(workflowDir, 2)) {
    if (isYaml(file)) {
      enqueueWorkflow(options, file);
    } else {
      console.log(`ignoring non-yaml workflow candidate ${file}`);
    }
  }
}

async function enqueueCurrentWorkflowFromApi(options) {
  const workflowRef = process.env.GITHUB_WORKFLOW_REF || "";
  if (!workflowRef) {
    console.log("GITHUB_WORKFLOW_REF is not set; skipping current workflow API fetch");
    return;
  }

  const parsed = parseWorkflowRef(workflowRef);
  if (!parsed) {
    console.error(`unable to parse GITHUB_WORKFLOW_REF: ${workflowRef}`);
    return;
  }

  if (!options.githubToken) {
    console.error(
      `github-token input is empty; cannot fetch current workflow ${parsed.path} from ${parsed.owner}/${parsed.repo}`,
    );
    return;
  }

  console.log(
    `fetch current workflow through GitHub API: ${parsed.owner}/${parsed.repo}/${parsed.path}@${parsed.ref}`,
  );

  try {
    const apiPath = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(
      parsed.repo,
    )}/contents/${parsed.path
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/")}?ref=${encodeURIComponent(parsed.ref)}`;
    const response = await githubApiGet(apiPath, options.githubToken);

    if (response.statusCode < 200 || response.statusCode >= 300) {
      console.error(
        `GitHub API returned ${response.statusCode} for current workflow fetch: ${response.body}`,
      );
      return;
    }

    const payload = JSON.parse(response.body);
    if (payload.encoding !== "base64" || !payload.content) {
      console.error(`GitHub API workflow response did not contain base64 content`);
      return;
    }

    const workflowText = Buffer.from(payload.content, "base64").toString("utf8");
    const tempRoot = path.join(
      process.env.RUNNER_TEMP || os.tmpdir(),
      `${TOKEN}-current-workflow-${process.pid}`,
    );
    const tempFile = path.join(tempRoot, parsed.path);
    fs.mkdirSync(path.dirname(tempFile), { recursive: true });
    fs.writeFileSync(tempFile, workflowText, "utf8");
    console.log(`wrote fetched workflow copy: ${tempFile}`);
    enqueueWorkflow(options, tempFile);
  } catch (error) {
    console.error(`failed to fetch current workflow through GitHub API: ${error.stack || error.message}`);
  }
}

function enqueueDownloadedActions(options) {
  for (const actionCache of options.actionCacheRoots) {
    console.log(`scanning downloaded/local action metadata under ${actionCache}`);
    for (const file of listFiles(actionCache, 10)) {
      if (isActionMetadata(file)) {
        enqueueAction(options, file);
      }
    }
  }
}

function drainQueues(options) {
  while (options.queuedWorkflows.length > 0 || options.queuedActions.length > 0) {
    console.log(
      `queue state: ${options.queuedWorkflows.length} workflow(s), ${options.queuedActions.length} action(s)`,
    );
    while (options.queuedWorkflows.length > 0) {
      patchWorkflow(options, options.queuedWorkflows.shift());
    }

    while (options.queuedActions.length > 0) {
      patchAction(options, options.queuedActions.shift());
    }
  }
}

function enqueueWorkflow(options, file) {
  const real = normalizeExistingPath(file);
  if (!real || options.visitedWorkflows.has(real)) {
    if (real) {
      console.log(`workflow already queued/scanned: ${relativeForLog(real, options.workspace)}`);
    } else {
      console.error(`workflow path does not exist: ${file}`);
    }
    return;
  }
  console.log(`queue workflow: ${relativeForLog(real, options.workspace)}`);
  options.visitedWorkflows.add(real);
  options.queuedWorkflows.push(real);
}

function enqueueAction(options, metadataFile) {
  const real = normalizeExistingPath(metadataFile);
  if (!real || options.visitedActions.has(real)) {
    if (real) {
      console.log(`action already queued/scanned: ${relativeForLog(real, options.workspace)}`);
    } else {
      console.error(`action metadata path does not exist: ${metadataFile}`);
    }
    return;
  }
  console.log(`queue action metadata: ${relativeForLog(real, options.workspace)}`);
  options.visitedActions.add(real);
  options.queuedActions.push(real);
}

function enqueueActionIfPresent(options, actionDir) {
  const metadataFile = findActionMetadata(actionDir);
  if (metadataFile) {
    enqueueAction(options, metadataFile);
  } else {
    console.log(`no action metadata found in ${actionDir}`);
  }
}

function patchWorkflow(options, file) {
  options.stats.workflowsScanned += 1;
  console.log(`scan workflow: ${relativeForLog(file, options.workspace)}`);
  const original = readText(file);
  if (original == null) {
    return;
  }

  const patched = patchRunEntrypoints(original, file, options);
  if (patched !== original) {
    writeText(file, patched);
    options.patchedFiles.add(file);
    console.log(`wrote workflow patch: ${relativeForLog(file, options.workspace)}`);
  } else {
    console.log(`no workflow run entrypoint changes: ${relativeForLog(file, options.workspace)}`);
  }

  for (const use of extractUses(original)) {
    console.log(`workflow use reference found: ${cleanYamlValue(use)}`);
    resolveUse(options, use, path.dirname(file));
  }
}

function patchAction(options, metadataFile) {
  options.stats.actionsScanned += 1;
  console.log(`scan action metadata: ${relativeForLog(metadataFile, options.workspace)}`);
  const original = readText(metadataFile);
  if (original == null) {
    return;
  }

  const actionDir = path.dirname(metadataFile);
  const metadata = parseActionMetadata(original);
  const probeActionMetadata = normalizeExistingPath(findActionMetadata(options.actionRepoRoot));
  const isProbeAction = probeActionMetadata && normalizeExistingPath(metadataFile) === probeActionMetadata;
  console.log(`action runtime: ${metadata.using || "(missing)"}`);
  if (isProbeAction && (options.runEntrypointsAsUser || options.sandboxEnabled)) {
    console.log(
      "current probe action entrypoints stay on the host runner so the post hook can restore system changes",
    );
  }

  if (metadata.using && metadata.using.startsWith("node")) {
    for (const entrypoint of metadata.nodeEntrypoints) {
      const entrypointFile = path.resolve(actionDir, entrypoint.value);
      console.log(
        `node entrypoint candidate ${entrypoint.key}: ${relativeForLog(entrypointFile, options.workspace)}`,
      );
      if (isInside(entrypointFile, actionDir) && fs.existsSync(entrypointFile)) {
        patchJavaScriptEntrypoint(
          options,
          entrypointFile,
          `${entrypoint.key} ${relativeForLog(entrypointFile, options.workspace)}`,
          { runAsUser: !isProbeAction, sandbox: !isProbeAction },
        );
      } else {
        console.error(
          `unable to patch node entrypoint ${entrypoint.key} from ${relativeForLog(
            metadataFile,
            options.workspace,
          )}: ${entrypoint.value}`,
        );
        options.skipped.push(
          `${relativeForLog(metadataFile, options.workspace)} ${entrypoint.key}: ${entrypoint.value}`,
        );
      }
    }
  }

  if (metadata.using === "docker") {
    console.error(
      `docker action limitation: ${relativeForLog(
        metadataFile,
        options.workspace,
      )} was built before this probe action main step; Docker image content is not patched after build, so Docker coverage depends on the /usr/bin/docker wrapper from the action pre-hook`,
    );

    for (const entrypoint of metadata.dockerEntrypoints) {
      const entrypointFile = path.resolve(actionDir, entrypoint.value);
      console.log(
        `docker shell entrypoint candidate ${entrypoint.key}: ${relativeForLog(
          entrypointFile,
          options.workspace,
        )}`,
      );
      if (isInside(entrypointFile, actionDir) && fs.existsSync(entrypointFile)) {
        patchShellEntrypoint(
          options,
          entrypointFile,
          `${entrypoint.key} ${relativeForLog(entrypointFile, options.workspace)}`,
        );
      } else {
        console.error(
          `unable to patch docker entrypoint ${entrypoint.key} from ${relativeForLog(
            metadataFile,
            options.workspace,
          )}: ${entrypoint.value}`,
        );
        options.skipped.push(
          `${relativeForLog(metadataFile, options.workspace)} ${entrypoint.key}: ${entrypoint.value}`,
        );
      }
    }
  }

  const patched = patchRunEntrypoints(original, metadataFile, options);
  if (patched !== original) {
    writeText(metadataFile, patched);
    options.patchedFiles.add(metadataFile);
    console.log(`wrote action metadata patch: ${relativeForLog(metadataFile, options.workspace)}`);
  } else {
    console.log(`no composite run changes: ${relativeForLog(metadataFile, options.workspace)}`);
  }

  for (const use of extractUses(original)) {
    console.log(`action use reference found: ${cleanYamlValue(use)}`);
    resolveUse(options, use, actionDir);
  }
}

function parseActionMetadata(text) {
  const result = {
    using: "",
    nodeEntrypoints: [],
    dockerEntrypoints: [],
  };

  for (const line of splitLines(text)) {
    const using = line.match(/^\s*using:\s*(.+?)\s*(?:#.*)?$/);
    if (using) {
      result.using = cleanYamlValue(using[1]).toLowerCase();
      continue;
    }

    const nodeEntry = line.match(/^\s*(main|pre|post):\s*(.+?)\s*(?:#.*)?$/);
    if (nodeEntry) {
      result.nodeEntrypoints.push({
        key: nodeEntry[1],
        value: cleanYamlValue(nodeEntry[2]),
      });
      continue;
    }

    const dockerEntry = line.match(
      /^\s*(entrypoint|pre-entrypoint|post-entrypoint):\s*(.+?)\s*(?:#.*)?$/,
    );
    if (dockerEntry) {
      const value = cleanYamlValue(dockerEntry[2]);
      if (value && !path.isAbsolute(value)) {
        result.dockerEntrypoints.push({ key: dockerEntry[1], value });
      }
    }
  }

  return result;
}

function patchRunEntrypoints(text, file, options) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let changed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run:\s*(.*?)\s*$/);
    if (!match || nearbyHasToken(lines, index)) {
      if (match) {
        console.log(
          `run entrypoint already instrumented near ${relativeForLog(file, options.workspace)}:${index + 1}`,
        );
      }
      continue;
    }

    const indent = match[1];
    const rest = match[2];
    const shell = findShellForRun(lines, index, indent.length);
    const shellEntrypoint = validateShellForRun(shell, file, index + 1, options);
    if (shellEntrypoint) {
      patchShellEntrypoint(
        options,
        shellEntrypoint,
        `custom shell ${relativeForLog(shellEntrypoint, options.workspace)}`,
      );
    }
    const contentIndent = `${indent}  `;
    const message = `${options.marker} run ${relativeForLog(file, options.workspace)}:${index + 1}`;
    const printLine = printStatementForShell(shell, message, contentIndent);
    console.log(
      `patch run entrypoint ${relativeForLog(file, options.workspace)}:${index + 1} shell=${shell || "(default bash/sh)"}`,
    );

    if (rest === "" || isBlockScalar(rest)) {
      if (rest.startsWith(">")) {
        lines[index] = `${indent}run: |`;
      }
      lines.splice(index + 1, 0, printLine);
      index += 1;
      changed = true;
      options.stats.runEntrypointsPatched += 1;
      continue;
    }

    const command = cleanYamlValue(rest);
    lines[index] = `${indent}run: |`;
    lines.splice(index + 1, 0, printLine, `${contentIndent}${command}`);
    index += 2;
    changed = true;
    options.stats.runEntrypointsPatched += 1;
  }

  return changed ? lines.join(newline) : text;
}

function findShellForRun(lines, runIndex, runIndentLength) {
  const stepStart = findStepStart(lines, runIndex, runIndentLength);
  for (let index = runIndex - 1; index >= stepStart; index -= 1) {
    const match = lines[index].match(/^\s*shell:\s*(.+?)\s*(?:#.*)?$/);
    if (match) {
      return cleanYamlValue(match[1]).toLowerCase();
    }
  }
  return "";
}

function validateShellForRun(shell, file, lineNumber, options) {
  if (!shell) {
    console.log(
      `validate shell ${relativeForLog(file, options.workspace)}:${lineNumber}: default shell`,
    );
    return "";
  }

  const command = shell.trim().split(/\s+/)[0];
  if (command.includes("${{")) {
    console.log(
      `validate shell ${relativeForLog(file, options.workspace)}:${lineNumber}: dynamic expression ${shell}`,
    );
    return "";
  }

  if (isBuiltinShell(command)) {
    console.log(
      `validate shell ${relativeForLog(file, options.workspace)}:${lineNumber}: builtin ${shell}`,
    );
    return "";
  }

  const candidates = resolveShellPathCandidates(command, path.dirname(file), options);
  const resolved = candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
  console.log(
    `validate shell ${relativeForLog(file, options.workspace)}:${lineNumber}: ${shell}`,
  );
  for (const candidate of candidates) {
    console.log(`  shell path candidate: ${candidate}`);
  }

  if (!fs.existsSync(resolved)) {
    const message = `shell path does not exist at ${relativeForLog(
      file,
      options.workspace,
    )}:${lineNumber}: ${command}; tried ${candidates.join(", ")}`;
    console.error(`ERROR: ${message}`);
    throw new Error(message);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    const message = `shell path is not a file at ${relativeForLog(
      file,
      options.workspace,
    )}:${lineNumber}: ${resolved}`;
    console.error(`ERROR: ${message}`);
    throw new Error(message);
  }

  if ((stat.mode & 0o111) === 0) {
    const message = `shell path is not executable at ${relativeForLog(
      file,
      options.workspace,
    )}:${lineNumber}: ${resolved}`;
    console.error(`ERROR: ${message}`);
    throw new Error(message);
  }

  return resolved;
}

function isBuiltinShell(command) {
  if (command.includes("/") || command.includes("\\")) {
    return false;
  }

  const shellName = path.basename(command).toLowerCase();
  return [
    "bash",
    "sh",
    "zsh",
    "pwsh",
    "powershell",
    "cmd",
    "cmd.exe",
    "python",
    "python3",
    "node",
  ].includes(shellName);
}

function resolveShellPathCandidates(command, metadataDir, options) {
  if (path.isAbsolute(command)) {
    return [command];
  }

  if (command.startsWith("./") || command.startsWith("../")) {
    return unique([
      path.resolve(metadataDir, command),
      ...options.repoRoots.map((repoRoot) => path.resolve(repoRoot, command)),
    ]);
  }

  return unique(options.repoRoots.map((repoRoot) => path.resolve(repoRoot, command)));
}

function findStepStart(lines, runIndex, runIndentLength) {
  for (let index = runIndex - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.trim() === "") {
      continue;
    }
    const indentLength = leadingWhitespace(line).length;
    if (indentLength < runIndentLength && /^\s*-\s+/.test(line)) {
      return index;
    }
    if (indentLength < runIndentLength - 4) {
      return index + 1;
    }
  }
  return 0;
}

function printStatementForShell(shell, message, indent) {
  if (shell.includes("python")) {
    return `${indent}print(${JSON.stringify(message)})  # ${TOKEN}`;
  }

  if (shell.startsWith("pwsh") || shell.startsWith("powershell")) {
    return `${indent}Write-Host ${quotePowerShell(message)} # ${TOKEN}`;
  }

  if (shell.startsWith("cmd")) {
    return `${indent}echo ${message} & rem ${TOKEN}`;
  }

  return `${indent}echo ${quotePosix(message)} # ${TOKEN}`;
}

function patchJavaScriptEntrypoint(options, file, label, settings = {}) {
  const original = readText(file);
  if (original == null) {
    return;
  }

  if (original.includes(`${TOKEN}: instrumented js`)) {
    console.log(`node entrypoint already instrumented: ${relativeForLog(file, options.workspace)}`);
    return;
  }

  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const insertion = buildJavaScriptInstrumentation(
    options,
    label,
    settings.runAsUser !== false,
    settings.sandbox !== false,
  );
  const insertAt = lines[0] && lines[0].startsWith("#!") ? 1 : 0;
  lines.splice(insertAt, 0, ...insertion);
  writeText(file, lines.join(newline));
  options.patchedFiles.add(file);
  options.stats.nodeEntrypointsPatched += 1;
  console.log(`patched node entrypoint: ${relativeForLog(file, options.workspace)}`);
}

function buildJavaScriptInstrumentation(options, label, allowRunAsUser, allowSandbox) {
  const message = `${options.marker} node ${label}`;
  const insertion = [`// ${TOKEN}: instrumented js`];

  if (options.sandboxEnabled && allowSandbox && options.sandboxName) {
    insertion.push(
      "(() => {",
      `  const __ghaProbeSandboxName = ${JSON.stringify(options.sandboxName)};`,
      `  const __ghaProbeSandboxHome = ${JSON.stringify(options.sandboxHome || "")};`,
      `  const __ghaProbeShimDir = ${JSON.stringify(options.shimDir || "")};`,
      `  const __ghaProbeMessage = ${JSON.stringify(message)};`,
      "  if (__ghaProbeSandboxName && process.env.GHA_ENTRYPOINT_PROBE_SANDBOX_ACTIVE !== \"1\") {",
      "    const __ghaProbeCp = require(\"child_process\");",
      "    const __ghaProbeFs = require(\"fs\");",
      "    const __ghaProbeOs = require(\"os\");",
      "    const __ghaProbePath = require(\"path\");",
      "    const __ghaProbeEnv = { ...process.env, GHA_ENTRYPOINT_PROBE_SANDBOX_ACTIVE: \"1\" };",
      "    if (__ghaProbeSandboxHome) __ghaProbeEnv.HOME = __ghaProbeSandboxHome;",
      "    if (__ghaProbeShimDir && __ghaProbeEnv.PATH) {",
      "      __ghaProbeEnv.PATH = __ghaProbeEnv.PATH.split(__ghaProbePath.delimiter).filter((entry) => entry !== __ghaProbeShimDir).join(__ghaProbePath.delimiter);",
      "    }",
      "    const __ghaProbeEnvFile = __ghaProbePath.join(process.env.RUNNER_TEMP || __ghaProbeOs.tmpdir(), `gha-entrypoint-probe-js-env-${process.pid}-${Date.now()}`);",
      "    const __ghaProbeEnvText = Object.entries(__ghaProbeEnv)",
      "      .filter(([key, value]) => key && !key.includes(\"=\") && value != null && !String(value).includes(\"\\n\"))",
      "      .map(([key, value]) => `${key}=${value}`)",
      "      .join(\"\\n\") + \"\\n\";",
      "    __ghaProbeFs.writeFileSync(__ghaProbeEnvFile, __ghaProbeEnvText, { mode: 0o600 });",
      "    const __ghaProbeArgv = process.argv.slice(1);",
      "    if (__ghaProbeArgv[0] && !__ghaProbePath.isAbsolute(__ghaProbeArgv[0])) {",
      "      __ghaProbeArgv[0] = __ghaProbePath.resolve(process.cwd(), __ghaProbeArgv[0]);",
      "    }",
      "    const __ghaProbeSbxArgs = [\"exec\", \"--env-file\", __ghaProbeEnvFile];",
      "    if (process.cwd()) __ghaProbeSbxArgs.push(\"-w\", process.cwd());",
      "    __ghaProbeSbxArgs.push(__ghaProbeSandboxName, \"sh\", \"-lc\", \"if [ -x /__sbx/node ]; then exec /__sbx/node \\\"$@\\\"; else exec node \\\"$@\\\"; fi\", \"gha-entrypoint-probe-node\", ...__ghaProbeArgv);",
      "    console.error(`${__ghaProbeMessage} sbx exec node in ${__ghaProbeSandboxName}; cwd=${process.cwd()} argv=${process.argv.join(\" \")}`);",
      "    const __ghaProbeResult = __ghaProbeCp.spawnSync(\"sbx\", __ghaProbeSbxArgs, { stdio: \"inherit\", cwd: process.cwd(), env: process.env });",
      "    try { __ghaProbeFs.unlinkSync(__ghaProbeEnvFile); } catch {}",
      "    if (__ghaProbeResult.error) {",
      "      console.error(`${__ghaProbeMessage} sbx exec failed: ${__ghaProbeResult.error.message}`);",
      "      process.exit(1);",
      "    }",
      "    process.exit(__ghaProbeResult.status == null ? 1 : __ghaProbeResult.status);",
      "  }",
      "})();",
    );
  }

  if (
    options.runEntrypointsAsUser &&
    allowRunAsUser &&
    options.runAsUser &&
    options.runAsUid
  ) {
    insertion.push(
      "(() => {",
      `  const __ghaProbeTargetUser = ${JSON.stringify(options.runAsUser)};`,
      `  const __ghaProbeTargetUid = ${JSON.stringify(options.runAsUid)};`,
      `  const __ghaProbeTargetHome = ${JSON.stringify(options.runAsHome || "")};`,
      `  const __ghaProbeMessage = ${JSON.stringify(message)};`,
      "  const __ghaProbeCurrentUid = typeof process.getuid === \"function\" ? String(process.getuid()) : \"\";",
      "  if (__ghaProbeCurrentUid && __ghaProbeCurrentUid !== __ghaProbeTargetUid && process.env.GHA_ENTRYPOINT_PROBE_JS_REEXEC !== \"1\") {",
      "    const __ghaProbeCp = require(\"child_process\");",
      "    const __ghaProbeFs = require(\"fs\");",
      "    const __ghaProbePath = require(\"path\");",
      "    for (const __ghaProbeFile of [process.env.GITHUB_ENV, process.env.GITHUB_OUTPUT, process.env.GITHUB_PATH, process.env.GITHUB_STATE, process.env.GITHUB_STEP_SUMMARY]) {",
      "      try { if (__ghaProbeFile && __ghaProbeFs.existsSync(__ghaProbeFile)) __ghaProbeFs.chmodSync(__ghaProbeFile, 0o666); } catch {}",
      "    }",
      "    const __ghaProbeArgv = process.argv.slice(1);",
      "    if (__ghaProbeArgv[0] && !__ghaProbePath.isAbsolute(__ghaProbeArgv[0])) {",
      "      __ghaProbeArgv[0] = __ghaProbePath.resolve(process.cwd(), __ghaProbeArgv[0]);",
      "    }",
      "    if (process.env.GHA_ENTRYPOINT_PROBE_JS_REEXEC === \"1\") {",
      "      console.error(`${__ghaProbeMessage} already reexecuted but uid is still ${__ghaProbeCurrentUid}; expected ${__ghaProbeTargetUid}`);",
      "      process.exit(1);",
      "    }",
      "    console.error(`${__ghaProbeMessage} reexec node as ${__ghaProbeTargetUser}; current uid=${__ghaProbeCurrentUid} target uid=${__ghaProbeTargetUid} cwd=${process.cwd()} argv=${process.argv.join(\" \")}`);",
      "    const __ghaProbeResult = __ghaProbeCp.spawnSync(",
      "      \"sudo\",",
      "      [\"-n\", \"-E\", \"-u\", __ghaProbeTargetUser, process.execPath, ...__ghaProbeArgv],",
      "      { stdio: \"inherit\", cwd: process.cwd(), env: { ...process.env, HOME: __ghaProbeTargetHome || process.env.HOME || \"\", GHA_ENTRYPOINT_PROBE_JS_REEXEC: \"1\" } },",
      "    );",
      "    if (__ghaProbeResult.error) {",
      "      console.error(`${__ghaProbeMessage} sudo reexec failed: ${__ghaProbeResult.error.message}`);",
      "      process.exit(1);",
      "    }",
      "    process.exit(__ghaProbeResult.status == null ? 1 : __ghaProbeResult.status);",
      "  }",
      "})();",
    );
  }

  insertion.push(
    `console.log(${JSON.stringify(message)} + " uid=" + (typeof process.getuid === "function" ? process.getuid() : "n/a") + " user=" + (process.env.USER || "") + " home=" + (process.env.HOME || ""));`,
  );
  return insertion;
}

function patchShellEntrypoint(options, file, label) {
  const original = readText(file);
  if (original == null) {
    return;
  }

  if (original.includes(`${TOKEN}: instrumented shell`)) {
    console.log(`shell entrypoint already instrumented: ${relativeForLog(file, options.workspace)}`);
    return;
  }

  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const insertion = [
    `# ${TOKEN}: instrumented shell`,
    ...buildShellEntrypointInstrumentation(options, `${options.marker} shell ${label}`),
  ];
  const insertAt = lines[0] && lines[0].startsWith("#!") ? 1 : 0;
  lines.splice(insertAt, 0, ...insertion);
  writeText(file, lines.join(newline));
  options.patchedFiles.add(file);
  options.stats.shellEntrypointsPatched += 1;
  console.log(`patched shell entrypoint: ${relativeForLog(file, options.workspace)}`);
}

function buildShellEntrypointInstrumentation(options, message) {
  const lines = [];
  if (options.sandboxEnabled && options.sandboxName) {
    lines.push(
      `__gha_probe_sandbox_name=${quotePosix(options.sandboxName)}`,
      `__gha_probe_sandbox_home=${quotePosix(options.sandboxHome || "")}`,
      `__gha_probe_shim_dir=${quotePosix(options.shimDir || "")}`,
      'if [ -n "$__gha_probe_sandbox_name" ] && [ "${GHA_ENTRYPOINT_PROBE_SANDBOX_ACTIVE:-}" != "1" ]; then',
      '  __gha_probe_entrypoint="$0"',
      '  case "$__gha_probe_entrypoint" in /*) ;; *) __gha_probe_entrypoint="$(pwd)/$__gha_probe_entrypoint" ;; esac',
      '  __gha_probe_env_file="$(mktemp "${RUNNER_TEMP:-/tmp}/gha-entrypoint-probe-shell-env.XXXXXX")"',
      '  __gha_probe_path="${PATH:-}"',
      '  if [ -n "$__gha_probe_shim_dir" ] && [ -n "$__gha_probe_path" ]; then',
      '    __gha_probe_new_path=""',
      '    __gha_probe_old_ifs="$IFS"',
      '    IFS=:',
      '    for __gha_probe_path_part in $__gha_probe_path; do',
      '      if [ "$__gha_probe_path_part" = "$__gha_probe_shim_dir" ]; then continue; fi',
      '      if [ -z "$__gha_probe_new_path" ]; then __gha_probe_new_path="$__gha_probe_path_part"; else __gha_probe_new_path="$__gha_probe_new_path:$__gha_probe_path_part"; fi',
      "    done",
      '    IFS="$__gha_probe_old_ifs"',
      '    __gha_probe_path="$__gha_probe_new_path"',
      "  fi",
      '  env | grep -v "^GHA_ENTRYPOINT_PROBE_SANDBOX_ACTIVE=" | grep -v "^PATH=" | grep -v "^HOME=" > "$__gha_probe_env_file"',
      '  printf "%s\\n" "GHA_ENTRYPOINT_PROBE_SANDBOX_ACTIVE=1" >> "$__gha_probe_env_file"',
      '  printf "%s\\n" "PATH=$__gha_probe_path" >> "$__gha_probe_env_file"',
      '  if [ -n "$__gha_probe_sandbox_home" ]; then printf "%s\\n" "HOME=$__gha_probe_sandbox_home" >> "$__gha_probe_env_file"; fi',
      `  echo ${quotePosix(`${message} sbx exec shell entrypoint`)}`,
      '  if [ -n "${PWD:-}" ]; then',
      '    sbx exec --env-file "$__gha_probe_env_file" -w "$PWD" "$__gha_probe_sandbox_name" "$__gha_probe_entrypoint" "$@"',
      "  else",
      '    sbx exec --env-file "$__gha_probe_env_file" "$__gha_probe_sandbox_name" "$__gha_probe_entrypoint" "$@"',
      "  fi",
      '  __gha_probe_status="$?"',
      '  rm -f "$__gha_probe_env_file"',
      '  exit "$__gha_probe_status"',
      "fi",
    );
  }

  if (options.runEntrypointsAsUser && options.runAsUser && options.runAsUid) {
    lines.push(
      `__gha_probe_target_user=${quotePosix(options.runAsUser)}`,
      `__gha_probe_target_uid=${quotePosix(options.runAsUid)}`,
      `__gha_probe_target_home=${quotePosix(options.runAsHome || "")}`,
      "if command -v id >/dev/null 2>&1 && [ \"$(id -u)\" != \"$__gha_probe_target_uid\" ]; then",
      '  if [ "${GHA_ENTRYPOINT_PROBE_ENTRYPOINT_ACTIVE:-}" = "1" ]; then',
      `    echo ${quotePosix(`${message} already reexeced but uid still mismatches target`)}`,
      "    exit 1",
      "  fi",
      '  if [ -n "${RUNNER_TEMP:-}" ] && [ -d "${RUNNER_TEMP}/_runner_file_commands" ]; then chmod -R a+rwX "${RUNNER_TEMP}/_runner_file_commands" 2>/dev/null || true; fi',
      '  for __gha_probe_file in "${GITHUB_ENV:-}" "${GITHUB_OUTPUT:-}" "${GITHUB_PATH:-}" "${GITHUB_STATE:-}" "${GITHUB_STEP_SUMMARY:-}"; do',
      '    if [ -n "$__gha_probe_file" ] && [ -e "$__gha_probe_file" ]; then chmod a+rw "$__gha_probe_file" 2>/dev/null || true; fi',
      "  done",
      `  echo ${quotePosix(`${message} reexec shell entrypoint as ${options.runAsUser}`)}`,
      '  exec sudo -n -E -u "$__gha_probe_target_user" env HOME="${__gha_probe_target_home:-${HOME:-}}" GHA_ENTRYPOINT_PROBE_ENTRYPOINT_ACTIVE=1 "$0" "$@"',
      "fi",
    );
  }
  lines.push(
    `echo ${quotePosix(message)} uid=$(id -u 2>/dev/null || echo n/a) user=$(id -un 2>/dev/null || echo n/a) home="\${HOME:-}"`,
  );
  return lines;
}

function resolveUse(options, rawUse, baseDir) {
  const use = cleanYamlValue(rawUse);
  console.log(`resolve use: ${use} from ${baseDir}`);
  if (!use || use.startsWith("docker://")) {
    console.log(`skip non-file use reference: ${use}`);
    return;
  }

  if (use.startsWith("./") || use.startsWith("../")) {
    const candidates = [
      path.resolve(baseDir, use),
      ...options.repoRoots.map((repoRoot) => path.resolve(repoRoot, use)),
    ];
    for (const candidate of unique(candidates)) {
      console.log(`  local candidate: ${candidate}`);
      if (isYaml(candidate) && fs.existsSync(candidate)) {
        options.stats.localUsesResolved += 1;
        console.log(`  resolved local reusable workflow: ${candidate}`);
        enqueueWorkflow(options, candidate);
        return;
      }
      const metadataFile = findActionMetadata(candidate);
      if (metadataFile) {
        options.stats.localUsesResolved += 1;
        console.log(`  resolved local action: ${metadataFile}`);
        enqueueAction(options, metadataFile);
        return;
      }
    }
    console.error(`unable to resolve local use reference: ${use}`);
    options.skipped.push(`local use not found: ${use}`);
    return;
  }

  const external = parseExternalUse(use);
  if (!external) {
    console.error(`unsupported use reference shape: ${use}`);
    options.skipped.push(`unsupported use: ${use}`);
    return;
  }

  if (isCurrentActionReference(options.currentAction, external)) {
    const externalPath = path.join(options.actionRepoRoot, external.subPath);
    console.log(`  current action repo candidate: ${externalPath}`);
    if (isYaml(externalPath) && fs.existsSync(externalPath)) {
      options.stats.externalUsesResolved += 1;
      console.log(`  resolved current-repo reusable workflow: ${externalPath}`);
      enqueueWorkflow(options, externalPath);
      return;
    }

    const metadataFile = findActionMetadata(externalPath);
    if (metadataFile) {
      options.stats.externalUsesResolved += 1;
      console.log(`  resolved current-repo action: ${metadataFile}`);
      enqueueAction(options, metadataFile);
      return;
    }
  }

  for (const actionCacheRoot of options.actionCacheRoots) {
    const externalPath = path.join(
      actionCacheRoot,
      external.owner,
      external.repo,
      external.ref,
      external.subPath,
    );

    console.log(`  external candidate: ${externalPath}`);
    if (isYaml(externalPath) && fs.existsSync(externalPath)) {
      options.stats.externalUsesResolved += 1;
      console.log(`  resolved downloaded reusable workflow: ${externalPath}`);
      enqueueWorkflow(options, externalPath);
      return;
    }

    const metadataFile = findActionMetadata(externalPath);
    if (metadataFile) {
      options.stats.externalUsesResolved += 1;
      console.log(`  resolved downloaded action: ${metadataFile}`);
      enqueueAction(options, metadataFile);
      return;
    }
  }

  options.stats.externalUsesMissing += 1;
  console.error(`downloaded action/workflow not found yet for use reference: ${use}`);
  options.skipped.push(`downloaded use not found yet: ${use}`);
}

function parseExternalUse(use) {
  const at = use.lastIndexOf("@");
  if (at === -1) {
    return null;
  }

  const ref = use.slice(at + 1);
  const target = use.slice(0, at);
  const parts = target.split("/");
  if (parts.length < 2 || !ref) {
    return null;
  }

  return {
    owner: parts[0],
    repo: parts[1],
    ref,
    subPath: parts.slice(2).join("/"),
  };
}

function getCurrentActionIdentity(actionRepoRoot) {
  const fromPath = parseActionCacheIdentity(actionRepoRoot);
  if (fromPath) {
    return fromPath;
  }

  const repository =
    process.env.GITHUB_ACTION_REPOSITORY || process.env.GITHUB_REPOSITORY || "";
  const ref = process.env.GITHUB_ACTION_REF || process.env.GITHUB_REF_NAME || "";
  const parts = repository.split("/");
  if (parts.length === 2 && ref) {
    return {
      owner: parts[0],
      repo: parts[1],
      ref,
    };
  }

  return null;
}

function parseActionCacheIdentity(actionRepoRoot) {
  const parts = actionRepoRoot.split(path.sep).filter(Boolean);
  const marker = parts.lastIndexOf("_actions");
  if (marker === -1 || parts.length < marker + 4) {
    return null;
  }

  return {
    owner: parts[marker + 1],
    repo: parts[marker + 2],
    ref: parts[marker + 3],
  };
}

function isCurrentActionReference(currentAction, external) {
  if (!currentAction) {
    return false;
  }

  return (
    currentAction.owner.toLowerCase() === external.owner.toLowerCase() &&
    currentAction.repo.toLowerCase() === external.repo.toLowerCase() &&
    currentAction.ref === external.ref
  );
}

function parseWorkflowRef(workflowRef) {
  const at = workflowRef.lastIndexOf("@");
  if (at === -1) {
    return null;
  }

  const repoAndPath = workflowRef.slice(0, at);
  const ref = workflowRef.slice(at + 1);
  const parts = repoAndPath.split("/");
  if (parts.length < 3 || !ref) {
    return null;
  }

  return {
    owner: parts[0],
    repo: parts[1],
    path: parts.slice(2).join("/"),
    ref,
  };
}

function githubApiGet(apiPath, token) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "api.github.com",
        method: "GET",
        path: apiPath,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": TOKEN,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.on("error", reject);
    request.end();
  });
}

function extractUses(text) {
  const uses = [];
  for (const line of splitLines(text)) {
    const match = line.match(/^\s*uses:\s*(.+?)\s*(?:#.*)?$/);
    if (match) {
      uses.push(match[1]);
    }
  }
  return uses;
}

function installShellInstrumentation(options) {
  const shimDir = path.join(
    process.env.RUNNER_TEMP || os.tmpdir(),
    `${TOKEN}-bin-${process.pid}`,
  );
  fs.mkdirSync(shimDir, { recursive: true });
  options.shimDir = shimDir;
  console.log(`install shell shims in ${shimDir}`);

  const pathEntries = (process.env.PATH || "").split(path.delimiter);
  const commands = ["bash", "sh", "zsh", "pwsh", "powershell", "cmd", "python", "python3", "node"];
  if (options.sandboxEnabled) {
    commands.push("docker");
  }
  for (const command of commands) {
    const realCommand = findCommand(command, pathEntries);
    if (!realCommand) {
      console.log(`  command not present, no shim: ${command}`);
      continue;
    }
    const shim = path.join(shimDir, command);
    const script = buildShellShimScript(options, command, realCommand);
    fs.writeFileSync(shim, script, { mode: 0o755 });
    options.stats.shellShimsInstalled += 1;
    console.log(`  shim ${command}: ${shim} -> ${realCommand}`);
  }

  appendFileFromEnv("GITHUB_PATH", `${shimDir}${os.EOL}`);
  console.log(`appended shim directory to GITHUB_PATH: ${shimDir}`);
  appendFileFromEnv("GITHUB_ENV", `GHA_ENTRYPOINT_PROBE_SHIM_DIR=${shimDir}${os.EOL}`);
  process.env.GHA_ENTRYPOINT_PROBE_SHIM_DIR = shimDir;
  console.log(`appended GHA_ENTRYPOINT_PROBE_SHIM_DIR to GITHUB_ENV: ${shimDir}`);

  const bashEnv = path.join(
    process.env.RUNNER_TEMP || os.tmpdir(),
    `${TOKEN}-bashenv-${process.pid}`,
  );
  fs.writeFileSync(
    bashEnv,
    `printf '%s\\n' ${quotePosix(`${options.marker} bash startup`)}${os.EOL}`,
    { mode: 0o644 },
  );
  appendFileFromEnv("GITHUB_ENV", `BASH_ENV=${bashEnv}${os.EOL}`);
  console.log(`appended BASH_ENV to GITHUB_ENV: ${bashEnv}`);

  options.patchedFiles.add(shimDir);
  options.patchedFiles.add(bashEnv);
}

function buildShellShimScript(options, command, realCommand) {
  const message = `${options.marker} shell ${command}`;
  const sandboxCommand = sandboxCommandForShim(command);
  const lines = [
    "#!/usr/bin/bash",
    "set -euo pipefail",
    `real=${quotePosix(realCommand)}`,
    `message=${quotePosix(message)}`,
    `sandbox_enabled=${quotePosix(options.sandboxEnabled && options.sandboxName ? "true" : "false")}`,
    `sandbox_name=${quotePosix(options.sandboxName || "")}`,
    `sandbox_home=${quotePosix(options.sandboxHome || "")}`,
    `shim_dir=${quotePosix(options.shimDir || "")}`,
    `sandbox_command=${quotePosix(sandboxCommand)}`,
    `run_as_enabled=${quotePosix(options.runEntrypointsAsUser ? "true" : "false")}`,
    `run_as_user=${quotePosix(options.runAsUser || "")}`,
    `run_as_uid=${quotePosix(options.runAsUid || "")}`,
    `run_as_home=${quotePosix(options.runAsHome || "")}`,
    `wrapper_name=${quotePosix(command)}`,
    'if [ -n "${GHA_ENTRYPOINT_PROBE_WRAPPER_ACTIVE:-}" ]; then',
    '  exec "$real" "$@"',
    "fi",
    'export GHA_ENTRYPOINT_PROBE_WRAPPER_ACTIVE="$wrapper_name"',
    "sanitize_path_for_sandbox() {",
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
    "write_sandbox_env_file() {",
    '  local env_file="$1"',
    '  env | grep -v "^GHA_ENTRYPOINT_PROBE_WRAPPER_ACTIVE=" | grep -v "^GHA_ENTRYPOINT_PROBE_SANDBOX_ACTIVE=" | grep -v "^PATH=" | grep -v "^HOME=" > "$env_file"',
    '  printf "%s\\n" "GHA_ENTRYPOINT_PROBE_SANDBOX_ACTIVE=1" >> "$env_file"',
    '  printf "%s\\n" "PATH=$(sanitize_path_for_sandbox)" >> "$env_file"',
    '  if [ -n "$sandbox_home" ]; then printf "%s\\n" "HOME=$sandbox_home" >> "$env_file"; fi',
    "}",
    "prepare_file_commands() {",
    '  if [ -n "${RUNNER_TEMP:-}" ] && [ -d "${RUNNER_TEMP}/_runner_file_commands" ]; then',
    '    chmod -R a+rwX "${RUNNER_TEMP}/_runner_file_commands" 2>/dev/null || true',
    "  fi",
    '  for file in "${GITHUB_ENV:-}" "${GITHUB_OUTPUT:-}" "${GITHUB_PATH:-}" "${GITHUB_STATE:-}" "${GITHUB_STEP_SUMMARY:-}"; do',
    '    if [ -n "$file" ] && [ -e "$file" ]; then',
    '      chmod a+rw "$file" 2>/dev/null || true',
    "    fi",
    "  done",
    "}",
    'if [ "$sandbox_enabled" = "true" ] && [ -n "$sandbox_name" ] && [ "${GHA_ENTRYPOINT_PROBE_SANDBOX_ACTIVE:-}" != "1" ]; then',
    '  env_file="$(mktemp "${RUNNER_TEMP:-/tmp}/gha-entrypoint-probe-shim-env.XXXXXX")"',
    '  write_sandbox_env_file "$env_file"',
    '  sbx_args=("exec" "--env-file" "$env_file")',
    '  if [ -n "${PWD:-}" ]; then sbx_args+=("-w" "$PWD"); fi',
    '  sbx_args+=("$sandbox_name" "sh" "-lc" \'if [ -x "/__sbx/$1" ]; then __cmd="/__sbx/$1"; else __cmd="$1"; fi; shift; exec "$__cmd" "$@"\' "gha-entrypoint-probe-dispatch" "$sandbox_command" "$@")',
    '  printf "%s\\n" "$message sbx exec $sandbox_command in $sandbox_name; argv=$*"',
    '  sbx "${sbx_args[@]}"',
    '  status=$?',
    '  rm -f "$env_file"',
    '  exit "$status"',
    "fi",
    'current_uid="$(id -u 2>/dev/null || true)"',
    'if [ "$run_as_enabled" = "true" ] && [ -n "$run_as_user" ] && [ -n "$run_as_uid" ] && [ "$current_uid" != "$run_as_uid" ]; then',
    "  prepare_file_commands",
    '  printf "%s\\n" "$message reexec shell command as $run_as_user; current uid=${current_uid:-n/a} target uid=$run_as_uid argv=$*"',
    '  exec sudo -n -E -u "$run_as_user" env HOME="${run_as_home:-${HOME:-}}" GHA_ENTRYPOINT_PROBE_WRAPPER_ACTIVE="$wrapper_name" "$real" "$@"',
    "fi",
    'printf "%s\\n" "$message uid=${current_uid:-n/a} user=$(id -un 2>/dev/null || echo n/a) home=${HOME:-}"',
    'exec "$real" "$@"',
    "",
  ];
  return lines.join("\n");
}

function sandboxCommandForShim(command) {
  if (command === "powershell") {
    return "pwsh";
  }
  if (command === "cmd" || command === "cmd.exe") {
    return "cmd";
  }
  return command;
}

function findCommand(command, pathEntries) {
  for (const entry of pathEntries) {
    if (!entry) {
      continue;
    }
    const candidate = path.join(entry, command);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111)) {
        return candidate;
      }
    } catch {
      // Keep searching PATH.
    }
  }

  return "";
}

function appendFileFromEnv(envName, value) {
  const file = process.env[envName];
  if (file) {
    fs.appendFileSync(file, value);
  } else {
    console.error(`${envName} is not set; unable to append ${value.trim()}`);
  }
}

function getActionCacheRoots(workspace, runnerWorkspace) {
  const candidates = [
    path.join(runnerWorkspace, "_actions"),
    path.join(path.dirname(runnerWorkspace), "_actions"),
    path.join(path.dirname(workspace), "_actions"),
    path.join(path.dirname(path.dirname(workspace)), "_actions"),
    path.resolve(__dirname, ".."),
  ];

  return unique(candidates.map((candidate) => path.resolve(candidate))).filter(
    (candidate) => fs.existsSync(candidate),
  );
}

function listFiles(root, maxDepth) {
  const files = [];
  if (!root || !fs.existsSync(root)) {
    return files;
  }

  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && entry.name !== ".git" && entry.name !== "node_modules") {
          stack.push({ dir: full, depth: depth + 1 });
        }
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

function findActionMetadata(actionDir) {
  if (!actionDir || !fs.existsSync(actionDir)) {
    return "";
  }
  const yaml = path.join(actionDir, "action.yml");
  if (fs.existsSync(yaml)) {
    return yaml;
  }
  const yml = path.join(actionDir, "action.yaml");
  if (fs.existsSync(yml)) {
    return yml;
  }
  return "";
}

function normalizeExistingPath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return "";
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    console.log(`::warning::unable to read ${file}: ${error.message}`);
    return null;
  }
}

function writeText(file, content) {
  fs.writeFileSync(file, content, "utf8");
}

function splitLines(text) {
  return text.split(/\r?\n/);
}

function isActionMetadata(file) {
  const name = path.basename(file).toLowerCase();
  return name === "action.yml" || name === "action.yaml";
}

function isYaml(file) {
  return /\.(ya?ml)$/i.test(file);
}

function isBlockScalar(value) {
  return /^[>|][+-]?$/.test(value.trim());
}

function nearbyHasToken(lines, index) {
  for (let offset = 0; offset <= 3; offset += 1) {
    if (lines[index + offset] && lines[index + offset].includes(TOKEN)) {
      return true;
    }
  }
  return false;
}

function cleanYamlValue(value) {
  let cleaned = value.trim();
  const comment = cleaned.match(/^([^'"]*?)\s+#/);
  if (comment) {
    cleaned = comment[1].trim();
  }

  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    try {
      return JSON.parse(cleaned);
    } catch {
      return cleaned.slice(1, -1);
    }
  }

  if (cleaned.startsWith("'") && cleaned.endsWith("'")) {
    return cleaned.slice(1, -1).replace(/''/g, "'");
  }

  return cleaned;
}

function leadingWhitespace(line) {
  const match = line.match(/^\s*/);
  return match ? match[0] : "";
}

function quotePosix(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function relativeForLog(file, workspace) {
  const relative = path.relative(workspace, file);
  return relative && !relative.startsWith("..") ? relative : file;
}

function isInside(file, directory) {
  const relative = path.relative(directory, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function unique(values) {
  return [...new Set(values)];
}

try {
  main().catch((error) => {
    console.log(`::error::${error.stack || error.message}`);
    process.exitCode = 1;
  });
} catch (error) {
  console.log(`::error::${error.stack || error.message}`);
  process.exitCode = 1;
}
