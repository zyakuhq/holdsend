# Releasing

All four packages share one version and are published together by the Release workflow ([.github/workflows/release.yml](../.github/workflows/release.yml)), with npm provenance.

1. Update every status line that says "unreleased" or "nothing published yet" (README, package READMEs, SECURITY, protocol), and move the "unreleased" section of [CHANGELOG.md](../CHANGELOG.md) under the version and date.
2. Set the same version in every `packages/*/package.json`, and in their `@holdsend/core` dependency. `npm run check` fails if they disagree, if a package would publish anything but its build output, README, LICENSE and NOTICE, or if a package cannot be loaded with import and require.
3. Run the Release workflow by hand. A manual run always dry-runs; read what it would publish.
4. Merge, then push a tag `v<version>` on that commit. The workflow builds and checks without any secret, then waits for a reviewer of the `npm-release` environment (the project lead) to approve publishing. It publishes core first and then the rest, skipping any version already on npm (so a re-run finishes a half-done release), and creates the GitHub release.

A version with a dash (for example `0.2.0-rc.1`) is published under the `next` tag, never `latest`.

Publishing uses npm trusted publishing: each package on npm trusts this repository's `release.yml` in the `npm-release` environment, and the workflow proves who it is with a short-lived GitHub identity. There is no npm token, so there is nothing to leak or rotate.

The trusted publishers allow staging only (`npm stage publish`, npm 11.15.0 or later). A release therefore needs two approvals from the project lead:

1. In GitHub, approve the publish job in the `npm-release` environment.
2. On npmjs.com, approve each staged package with 2FA, `@holdsend/core` first. Until then nobody can install the new version, and `npm view` does not show it.

The GitHub release is created when the workflow finishes, which can be before the npm approvals.

A newly added trusted publisher stays "pending validation" until the first publish through it. npm sets a deadline for that; if it passes, add the publisher again.
