# Contributing to HoldSend

Thank you for helping. HoldSend exists for people writing from places with bad or no connection, so correctness comes before features. A change that might send something twice, or lose it, will not be merged however useful it is.

## Getting started

```sh
git clone https://github.com/zyakuhq/holdsend.git
cd holdsend
npm install
npm run check   # lint, typecheck, tests, build, size budget, PII scan
git config core.hooksPath .githooks   # secret and PII scan before every push
```

Node 20 or newer.

## How we work

- Small pull requests, one idea each. `main` is always green.
- Every change to the outbox rules comes with a test that would have failed without it. If the change is about a failure (a lost answer, a killed app, two tabs), the test should reproduce that failure.
- Public API changes need a short note in [docs/decisions](docs/decisions): the context, the choice and why.
- Plain English in commits, pull requests and docs. Say what changed and why.
- Keep `@holdsend/core` free of runtime dependencies and within its size budget (`npm run size`).

## Data and privacy

- Tests and examples use synthetic data only. Never paste real messages, names, email addresses, phone numbers or logs into this repository, even redacted.
- CI runs a secret scanner and a PII scan on every pull request. If the PII scan flags something that is genuinely fine (for example an address in a documentation range), say so in the pull request rather than weakening the rule.

## Reporting security problems

Please do not open a public issue. See [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), as section 5 of that licence describes.
