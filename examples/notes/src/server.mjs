// The HoldSend notes example: the server.
//
// Run from the repository root:
//   npm install && npm run build && npm start --workspace holdsend-example-notes
//
// Uses Postgres when DATABASE_URL is set, otherwise PGlite (Postgres in
// WebAssembly, in memory), so it runs with no setup.
import { createNotesApp } from "./app.mjs";

const port = Number(process.env.PORT ?? 3000);
const notes = await createNotesApp({ databaseUrl: process.env.DATABASE_URL });
// Listens on this computer only by default: the demo's sign-in can be forged
// by anyone who can reach it. Set HOST=0.0.0.0 to reach it from a phone on
// your network (the Expo example), and only on a network you trust.
const host = process.env.HOST ?? "127.0.0.1";
const server = notes.app.listen(port, host, () => {
  const address = server.address();
  const shown = typeof address === "object" && address ? address.port : port;
  console.log(`HoldSend notes example: http://${host === "0.0.0.0" || host === "127.0.0.1" ? "localhost" : host}:${shown} (${notes.databaseLabel})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    void notes.close().finally(() => process.exit(0));
  });
}
