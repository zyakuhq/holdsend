# 0008: Flush order

Date: 2026-11-01. Status: accepted.

## Context

The Phase 2 audit asked whether a flush sends messages in the order they were written. It matters most for emergency messages ("trapped", then "rescued, ignore the above").

## Choice

**A flush tries items oldest written first, and does not promise ordered delivery.** If an earlier item gets a retry (no answer, server busy), the flush carries on with later items. Holding everything behind one failing item would let a single bad message block a person's whole queue, which is worse than a late message in an emergency. The core is also at its size budget, so an ordered mode is not added to it.

Apps that need order have two honest options: put a sequence number in the payload and let the receiver sort, or show the written time next to each message (`Written-At`, display only). The protocol page already says never to order by written time on the server.

A test in `packages/core/test/flush-order.test.ts` pins both facts: oldest first within a pass, and a later item going out while an earlier one waits for a retry.
