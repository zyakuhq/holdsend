# 0001: Name and licence

Date: 2026-10-25. Status: accepted.

## Context

The working name was SendOnce ("write offline, publish exactly once"). Before creating the repository we checked it:

- `sendonce` is already published on npm by an unrelated author (October 2026).
- Several unrelated GitHub repositories are named SendOnce, including email tools in the same space.
- The nearest alternatives we considered are already names of existing products.

A name that collides with other packages confuses users, search results and npm installs, and invites a trademark question later.

## Choice

**HoldSend.** Packages are published under the `@holdsend` scope (`@holdsend/core`, `@holdsend/web`, `@holdsend/react-native`, `@holdsend/server`). Repository: `zyakuhq/holdsend`.

Licence: **Apache-2.0**, with a NOTICE file.

## Why

- HoldSend says what the library does in two plain words: it holds what you wrote while there is no connection, then sends it. It reads well in sentences ("HoldSend keeps it, then sends it once").
- At the time of checking, `holdsend` was free as an npm package name and no GitHub repository used it.
- Apache-2.0 includes an explicit patent grant, which matters to the newsrooms, NGOs and public bodies most likely to use an offline publishing library, and it is accepted by almost every organisation's open-source policy.

## Follow-up

- The `@holdsend` npm organisation still has to be created by the project lead before the first release.
