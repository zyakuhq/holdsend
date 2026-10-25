# Governance

HoldSend is an open-source project started by Zyaku Inc. and supported by an Emergent Ventures grant (Mercatus Center).

## Roles

- **Maintainers** review and merge pull requests, cut releases and decide the roadmap. The project lead is Rohit Kashyap (Zyaku Inc.).
- **Contributors** are everyone who files an issue, reviews code or sends a pull request.

## How decisions are made

- Day-to-day changes are decided in pull requests. A pull request is merged when CI is green and a maintainer approves it.
- Decisions that change the public API, the wire protocol or a safety rule (exactly once, the written-time bounds, cancel, the confirmation age) are written up in [docs/decisions](docs/decisions) before or with the change, so the reasons stay with the code.
- Disagreements are settled by discussion in the open. If that does not settle it, the project lead decides and records why.

## Becoming a maintainer

Contributors who have made sustained, careful contributions can be invited to become maintainers by the existing maintainers. This file will list them.

## Independence from Zyaku

HoldSend is written from scratch for any app to use. Zyaku's own production app was the reference for the behaviour, but no Zyaku code or data is in this repository, and Zyaku gets no special treatment in reviews or the roadmap.
