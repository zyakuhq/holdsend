# 0012: A checked record of the public API

Date: 2026-11-13. Status: accepted.

## Context

Phase 4 freezes the API for 1.0. A freeze needs a way to see every change to the public API, including the ones nobody meant to make: a type widened by a refactor, an option renamed, a type an export refers to but that is not exported itself. Until now an API change was visible only if a reviewer read every `.d.ts` diff by hand, and the build output is not in the repository.

## Choice

- `scripts/api-surface.mjs` reads the built declaration files of every entry point in each package's `exports` and writes one record per package in `api/<package>.api.txt`: every exported name with its declaration (comments and private class members removed), then every type those declarations refer to that no entry point exports.
- `npm run check` and the CI check job run it and fail when the build differs from the record. After an intended change, `node scripts/api-surface.mjs --update` rewrites the record, and the diff is reviewed as an API change.
- Before 1.0 a change to the record is allowed, with a changelog line. From 1.0 on, removing or changing anything in the record needs a major version; adding is a minor version.
- The draft helpers marked "early, for 0.3" (decision 0011) are in the record like everything else. Being recorded does not make them stable before 1.0.

## Why

- The tool is small, written for this repository, and uses only TypeScript, which is already a dependency. A general API extractor would add a large dependency and its own configuration for four small packages.
- Plain text diffs well in a pull request, which is where API changes should be noticed.
- Types that are referenced but not exported (for example the pool type the Postgres store accepts) are part of the contract, so they are in the record too.

## Limits

- The record compares declarations as text. A change that only moves a type between files, or reorders union members, shows up as a change even when it is compatible; review decides.
- It checks types, not behaviour. Behaviour is pinned by the tests.
