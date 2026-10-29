# 0007: Emergency messages

Date: 2026-10-29. Status: accepted.

## Context

Phase 2 of the roadmap is an emergency module: help a short text message get out of a phone that has no signal, without sending it twice, and without lying about what the platform can do. It is a delivery aid, not an emergency service. Nothing here contacts emergency services, and apps that use it must keep telling people to call their local emergency number first.

People under stress behave differently from people writing a post:

- They tap Send again and again when nothing seems to happen. Each tap would otherwise be a new message.
- They write several messages while offline, each a little more urgent or a little more out of date ("trapped on the roof", then "water rising", then "rescued, ignore the above"). When the signal returns, sending all of them at once, possibly hours later, can alarm the people who receive them more than it helps.
- They need to know which route the message will take: sent in the background, sent only once the app is open, or handed to SMS.

The core already has most of what this needs: one key per item for life, the written time kept apart from the arrival time, honest cancel, and items that wait for a person.

## Choice

**An emergency outbox is an ordinary outbox with stricter rules, in its own queue.** `@holdsend/core/emergency` exports `EmergencyOutbox`, which wraps an `Outbox` over its own store (a separate IndexedDB database, or a separate key on React Native), and its own sender lock, so a large upload in the main queue cannot hold an emergency message up. Messages are text only: a string, trimmed, not empty, at most `maxLength` characters (default 1,000).

**The first message goes by itself; later ones wait for the person.** With `autoSend: "first"` (the default), a message written while no other emergency message from the same person is waiting is sent automatically when the connection returns. A message stuck after the server refused it does not count as waiting: it needs the person's decision anyway. A message written while an earlier one is still waiting is held: it is shown, and it goes only when the person presses Send for it or Send all. `"all"` sends every message automatically and `"none"` holds every one. Held messages are sent oldest first.

**Repeated taps are one message.** A message whose text matches a waiting message from the same person, ignoring case, spacing at the ends and repeated spaces, and written within `dedupeWithinMs` (default ten minutes) of it, is not queued again. `write()` returns the existing message and `duplicate: true`. A message that was already delivered is never matched: writing the same words after delivery is a deliberate new message.

**Old messages ask first.** Even the first message is not sent automatically once it is older than `confirmAfterMs`, which defaults to one day here instead of the core's thirty days. The app shows when it was written and asks. The time is stored on each message (`askBy`, from a new `askAfterMs` option on `add()`), so a service worker that sends with a plain `Outbox` and the core's default policy follows it too.

**The decision is made inside the store's atomic update.** Two tabs pressing Send at the same moment must not both decide "this is the first message", and must not both queue the same words. The core gets one general hook for this, `add(kind, payload, { decide })`. `decide` runs inside the same atomic update that adds the item, with the items queued at that instant, and returns either an existing item (add nothing and return it), `"hold"`, or nothing. `decide` gets copies of the queued items, so it cannot change them. A held item is a new optional flag on `OutboxItem` (`held: true`). `needsConfirmation` treats it like an item past the confirmation age, so `approve()`, `statusOf()` and every sender already handle it.

**SMS is a hand-off, never a silent send.** `smsLink(to, body, { platform })` builds an `sms:` link that opens the phone's messaging app with the text filled in. The person still presses send there. One recipient uses the standard form (`sms:<number>?body=<text>`). Several recipients use the form each platform accepts, since iOS does not follow the standard for that case. How phones read these links has changed between versions, so apps should test them on real phones. Before a hand-off, the app calls `cancel(key)`. If the message never left the device it is removed, so it cannot arrive twice. If it may already have left, `cancel` says `"in_flight"`, and the app must tell the person the message may arrive twice. An SMS needs a phone signal, but often works when mobile data does not.

**Background sending where the platform has it, and the truth where it does not.** On the web, the emergency queue uses its own Background Sync tag and the existing helpers. `requestBackgroundSync()` returns `"background"` only after a registration succeeded. On iOS, in Firefox and in React Native today, messages go only once the app is open with a connection, and the app must say so and offer SMS. The docs carry a per-platform table.

**The server side needs nothing new.** Emergency messages go through `handleIdempotent` like any other create, with `requireKey: true` and records kept for as long as a phone may retry.

## Why

- Holding later messages trades a little speed for not flooding the people who receive them with stale, contradictory alerts. The first message, usually the one that matters most, is not slowed down. Apps that disagree can choose `"all"`.
- Matching on text and time, not on the key, is what catches a person tapping Send again. Keys catch the machine retrying. The two are different problems.
- Putting the decision inside the atomic update, rather than reading the queue first and adding afterwards, is what makes it correct with several tabs. A general hook in the core costs a few lines. The alternative, the emergency code writing items into the store itself, would copy the core's validation and let the two drift apart.
- A subpath of `@holdsend/core`, not a new package, keeps the main entry within its size budget. It also avoids setting up a new npm package with its own trusted publisher.

## Limits, stated plainly

- No platform lets a web page or a React Native app send an SMS by itself. The person always presses send in the messaging app.
- Nothing is sent while the app is closed on iOS, in Firefox, or in React Native today. A background task for Android is planned for Phase 3.
- Matching repeated taps compares text only. Two different messages with the same words, written minutes apart while still waiting, are treated as one. That is intended, and documented for app authors.
