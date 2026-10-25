# Notes in React: the HoldSend React example

The [notes example](../notes) as a React app, plus three small hooks for using a HoldSend outbox from React. It uses the notes example's server and service worker, and passes the same browser scenarios: airplane mode, a lost answer, two tabs, cancel, a refused note, arrival ordering and the offline feed. The scenarios run against a development build, so React's StrictMode runs every effect twice and the hooks have to cope with it.

## Run it

From the repository root:

```sh
npm install
npm run build
npm start --workspace holdsend-example-react
```

Open http://localhost:3000. What to try is in the [notes example's README](../notes#try-to-break-it).

## The hooks

[`src/use-outbox.js`](src/use-outbox.js) is meant to be copied into your app. It may become a package once its shape has settled.

```jsx
// Create the store and outbox once, outside React (see src/main.jsx).
const store = await createWebStore({ name: "my-app-outbox" });
const outbox = new Outbox({ store, send });

function Composer({ owner }) {
  const { entries, loaded } = useOutboxEntries(outbox, { owner });
  const kick = useAutoFlush(outbox, { owner, lockName: "my-app-outbox-sender" });
  const online = useOnline();

  async function publish(text) {
    await outbox.add("post.create", { text }, { owner });
    kick(); // send now instead of waiting for the next pass
  }
  // ...
}
```

| Hook | What it does |
| --- | --- |
| `useOutboxEntries(outbox, { owner, pollMs })` | The waiting items and their status (`waiting`, `sending`, `needs_confirmation`, `stuck`), kept current after this tab's changes and every `pollMs` for other tabs. Returns `{ entries, loaded }`. Pass `owner` so a shared device never shows someone else's items. |
| `useAutoFlush(outbox, { owner, lockName, isOnline, onReport })` | Sends while the component is mounted: on start, when the connection returns, when the tab becomes visible, and on a backoff while items keep failing. Only `outbox`, `owner` and `lockName` restart it; the functions are read through refs. Returns a stable `kick()`. |
| `useOnline()` | Whether the browser says it is online. Use it for what the page says, not to decide whether something was sent. |

Things the hooks leave to you, on purpose:

- **Create the outbox once**, outside any component. A second `Outbox` over the same store is safe, but wasteful.
- **Tell the person the truth.** `cancel()`, `discard()`, `approve()` and `retry()` each return what actually happened. See how [`src/App.jsx`](src/App.jsx) turns those results into messages, and asks before a retry that would use a new key.

## Licence

Apache-2.0
