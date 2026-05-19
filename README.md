# GitHub Actions Entrypoint Probe

This repository contains a single action that is meant to run as the first step
on a GitHub-hosted runner. It scans workflow/action metadata it can see, follows
`uses:` references, and patches entrypoints so later execution prints a marker
before the original body runs.

The action is intentionally noisy. It prints environment discovery, path
resolution, every workflow/action file queued, every `uses:` reference, every
entrypoint patch, and a final count summary. Hard failures and suspicious path
resolution are written to stderr.

## Usage

```yaml
steps:
  - name: Probe entrypoints first
    uses: fiam/gha-test@main
    with:
      github-token: ${{ github.token }}
      marker: "[entrypoint-probe] before"
```

The included shared-runner demo is
[`.github/workflows/entrypoint-probe.yml`](.github/workflows/entrypoint-probe.yml).
It runs the probe before checkout, then exercises:

- workflow `run:` steps with the default shell
- workflow `run:` steps with `shell: bash`, `sh`, `python`, and `pwsh`
- workflow `run:` with a custom shell path
- JavaScript action `pre`, `main`, and `post`
- composite action `run` steps and nested `uses:`
- Docker action `pre-entrypoint`, `entrypoint`, and `post-entrypoint`
- a referenced reusable workflow

An opt-in sbx demo is
[`.github/workflows/sbx-entrypoint-probe.yml`](.github/workflows/sbx-entrypoint-probe.yml).
It uses the same patching pass, but the action pre-hook installs/starts `sbx`
on a normal `ubuntu-24.04` runner and the generated shell, JavaScript, and
Docker wrappers dispatch later entrypoints through `sbx exec`. Configure
`vars.DOCKER_USERNAME` and `secrets.DOCKER_PAT` for Docker Hub access, then run
the workflow manually.

## What Gets Patched

The entrypoint set follows GitHub's
[metadata syntax reference](https://docs.github.com/en/actions/reference/metadata-syntax-reference).

- JavaScript action metadata: `runs.pre`, `runs.main`, and `runs.post`
- Composite/action/workflow `run:` blocks
- Custom `shell:` paths used by `run:` steps
- Later top-level shell steps through `GITHUB_PATH` shims and `BASH_ENV`
- Later Docker invocations through a temporary `/usr/bin/docker` wrapper on
  Linux runners when `install-docker-wrapper` is enabled

When `sandbox-enabled: "true"` is set, patched entrypoints are re-executed in
the per-job sandbox instead of only printing the marker. The action mounts the
runner `_work` directory into the sandbox, passes the step environment through
an `--env-file`, and sets `GHA_ENTRYPOINT_PROBE_SANDBOX_ACTIVE=1` inside the
sandbox to avoid recursive wrapping.

This action-level mode is intentionally smaller than the custom sbx runner
setup: it does not install runner service hooks, bind-mount over the runner's
Node binaries, or proxy credentials. Secrets present in a step environment are
therefore passed into the sandbox process. The existing Dockerfile-action
timing caveat still applies: image build preparation that GitHub performs
before the first step cannot be moved into the sandbox by a later action.

On a shared runner, top-level workflow `run:` commands are already planned by
the time the first action step starts. The action still scans and patches the
workflow file copy when available, but the live proof for later top-level
`run:` steps comes from the installed shell shims/startup hook. Action metadata
and downloaded action source files are read from disk later and can be patched
directly.

The shared-runner demo intentionally includes Docker `pre-entrypoint`,
`entrypoint`, and `post-entrypoint` coverage. Dockerfile actions are built
before the probe can install its wrapper, so image build cannot be intercepted
from an action. The probe attempts to install `/usr/bin/docker` interception in
its action `pre` hook, then restores the original binary in `post`.

If a `shell:` value references an absolute or relative path and no executable
file can be found at the resolved candidates, the probe fails the job and prints
the missing path details to stderr.
