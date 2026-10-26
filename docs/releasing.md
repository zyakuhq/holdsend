# Releasing

All four packages share one version and are published together by the Release workflow ([.github/workflows/release.yml](../.github/workflows/release.yml)), with npm provenance.

1. Move the "unreleased" section of [CHANGELOG.md](../CHANGELOG.md) under the version and date.
2. Set the same version in every `packages/*/package.json`, and in their `@holdsend/core` dependency. `npm run check` fails if they disagree, or if a package would publish anything but its build output, README and LICENSE.
3. Run the Release workflow by hand with "dry run" on, and read what it would publish.
4. Merge, then push a tag `v<version>` on that commit. The workflow checks the tag against the versions, runs every check, publishes core first and then the rest, and creates the GitHub release.

Publishing uses the `NPM_TOKEN` repository secret until npm trusted publishing is set up for each package; after that the token is deleted. A release is never published without the project lead's go-ahead.
