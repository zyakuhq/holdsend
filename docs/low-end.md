# Long queues and slow phones

> Measured on a laptop with an in-memory fake of AsyncStorage on 2026-11-10. Not measured on a real low-end phone yet. Real phones are slower, so treat these numbers as a floor.

`KeyValueStore` in `@holdsend/react-native` keeps the whole queue as one JSON string. Every change reads the string, changes it and writes all of it back. That keeps it simple and safe (one atomic write, nothing half saved), but the bytes written grow with the square of the queue length.

## What we measured

Each item is a small note. Adding all items and then sending them all, with a store that does no real disk work:

| Items | Payload each | Storage writes | Data written | Add time | Send time |
|------:|-------------:|---------------:|-------------:|---------:|----------:|
| 100 | 200 bytes | 301 | 9 MB | 17 ms | 50 ms |
| 500 | 200 bytes | 1,501 | 224 MB | 264 ms | 1.2 s |
| 1,000 | 200 bytes | 3,001 | 894 MB | 1.1 s | 4.8 s |
| 200 | 5,000 bytes | 601 | 516 MB | 471 ms | 1.9 s |

The number of writes is steady at three per item (one at add, two while sending). The size of each write is what grows. On a phone, flash storage and the JavaScript bridge cost far more than this fake does, and flash wears with every write.

## What to do

- Keep the queue short. A person writing notes by hand rarely passes a few dozen waiting items. Under 100 small items is comfortable. Hundreds of items, or items with large payloads, are the case to avoid.
- Do not put files or photos in the payload. Store them by their own means and put a reference in the payload.
- Leave `maxBytes` at its default (1.5 MB) unless you have measured your own app. It stops a queue from growing until the phone struggles; the add that would pass it fails and nothing is written.
- With MMKV (`fromMmkv`) reads and writes are synchronous and much cheaper than AsyncStorage, but the whole string is still rewritten.
- For a high-volume queue, write your own `Store` (the interface is small) that keeps one record per item. [decision 0009](decisions/0009-two-device-drafts.md) and the emergency module's own queue are examples of keeping separate queues apart.

## What is not decided

A per-item store in the package would remove the growth, but it is a larger change with its own crash cases, and no one has asked for queues of that size yet. A test now pins the writes-per-item count so a change cannot make the cost worse by accident. A check on a real low-end Android phone is still open.
