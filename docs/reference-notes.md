# Notes from the reference design

HoldSend's behaviour follows the offline publishing that Zyaku already runs in production. These notes record what that design does and which edge cases it learned the hard way, in our own words. No Zyaku code, data, names or configuration were copied; HoldSend is written from scratch.

## What the reference does

**A queue on the device.** Anything written without a connection goes into a queue kept in durable device storage (IndexedDB on the web, a key-value store on mobile). The queue survives closing and reloading the app.

**One key per item, for life.** Each item gets a random key when it is queued. Every attempt sends that same key. Nothing in the retry path ever makes a new one, with one exception (below).

**The server keeps a record per key.** For each (person, operation, key) there is one record. The first request with a key claims it, creates the post, and marks the record complete in the same database transaction as the post itself, so there is never a post without a record or a record without a post. A retry with the same key and the same content gets the original post back. The same key with different content is refused as a conflict. A retry that arrives while the first attempt is still running is told to wait.

**Claims, not just locks.** Before sending, a sender marks the item as "sending" inside one atomic storage update, re-reading the item as it does so. Two senders that read the same snapshot cannot both claim it. A sender renews its claim during a long upload; a claim nobody renews for a couple of minutes belonged to a sender that died, and another sender may take it over with the same key.

**One sender per device, one writer at a time.** Tabs coordinate with the Web Locks API, with a short lease in local storage where Web Locks is missing. There are two separate locks: one held for a whole send pass (only one tab sends), one held for the milliseconds a write takes (no tab overwrites another tab's change). They are always taken in the same order, so they cannot deadlock.

**Written time is display only.** A queued post carries the time the person wrote it. The server accepts it only on the offline replay path, bounds it (at most two minutes ahead of the server clock, at most 30 days back, clamped so it is never after arrival) and stores it next to the arrival time. Every feed still orders by arrival. A post's card can say "written offline at 08:15, posted at 11:40"; it can never move itself back in a feed.

**Some content must not carry a written time.** For content published anonymously, the time it was written can reveal when, and roughly where, a protected source was without a network. The reference leaves the written time out entirely for such content.

**Old items wait for their person.** Anything written more than 30 days ago is never sent automatically: the world it described has moved on, and a month-late emergency reads like a new one. It is shown with Send and Discard. Send goes with the same key, so if an earlier attempt did reach the server, the server answers with the original.

**Server records last as long as the content.** A post can wait weeks in a queue, and the answer to its final send can be lost, so a short-lived record would let a late retry create a second post. Completed records for posts are kept for the life of the account. When the post is deleted, the record becomes a tombstone that answers "gone" instead of letting a retry recreate it.

**Cancel is only for what never left.** An item that has been attempted even once may exist on the server (the answer may have been lost). Removing the local copy would throw away the same-key retry that settles it, and "it won't be sent" would be untrue. So only an untouched item can be cancelled; anything else shows as sending and is finished.

**The one time a key changes.** If the server says the key already holds a different request, retrying with that key can never succeed, and the server has proved nothing was created for this content under it. Only then, and only when the person asks to try again, does the item get a new key.

**Not durable means say so.** Some private browsing modes have no durable storage. The reference probes storage with a write and read-back, keeps an in-memory mirror so items still send while the tab is open, and tells the person that closing the tab will lose what is waiting.

**Counts tell the truth.** An item that used up its automatic attempts is not "syncing". The reference reports those separately, as needing a decision, after finding that counting them as "syncing" hid them from the person who had to decide.

## Emergency messages

**A separate queue.** Emergency messages are text only and live in their own queue with their own storage, so a large photo upload can never hold them up.

**Retry for longer, never twice.** A transient failure must never lose an emergency message, so retries are not capped; they back off to a ceiling instead. Each attempt carries the same item id, and the server keeps a unique receipt per (device credential, item), so retrying forever cannot create a second message.

**Sending after the app closes, where possible.** On Chromium browsers with Background Sync, a dedicated service worker sends queued emergency messages when the connection returns, even with no tab open. It never intercepts other requests, never caches, never sees the normal session token (it uses a narrow, device-bound, revocable credential for one route only) and coordinates with open pages through the same lock.

**Honest about platforms.** "Will be sent in the background" is shown only after a background sync actually registered, never from feature detection alone. On iOS, Firefox and native builds without a background path, the screen says the message goes when the app is open with signal, and offers SMS as well.

**The person can stop it.** Any emergency message not yet sent can be marked "don't send", and every sender respects that. A message on the wire right now cannot be stopped, and the interface does not pretend otherwise.

## What HoldSend changes

- The written time travels in a `Written-At` header rather than the request body, so the body the server hashes is exactly what the person wrote and no transport field needs excluding.
- A result reported by a sender whose claim was taken over is ignored, except "sent", which is a fact about the server. This stops a slow, presumed-dead sender from undoing the work of the sender that replaced it.
- Discard reports honestly whether a copy may already exist on the server.
- Storage is an interface with one hard rule (atomic update), so the same rules run against IndexedDB, AsyncStorage, MMKV or memory.
