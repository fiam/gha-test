# Hello from Third Party Action

This repository exposes a tiny public composite action for testing action
reference policies.

```yaml
jobs:
  signed-action-ref:
    runs-on: ubuntu-latest
    steps:
      - uses: fiam/gha-test@signed

  unsigned-action-ref:
    runs-on: ubuntu-latest
    steps:
      - uses: fiam/gha-test@unsigned
```

By default, the action prints:

```text
hello from 3rd party action (signed)
hello from 3rd party action (unsigned)
```

For the demo refs:

- `signed` should point at a signed commit and have a signed annotated tag.
- `unsigned` should point at an unsigned commit and have an unsigned annotated
  tag.

That gives a policy demo two third-party action refs with the same behavior but
different signature properties.
