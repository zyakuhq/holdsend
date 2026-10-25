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
const server = notes.app.listen(port, () => {
  const address = server.address();
  const shown = typeof address === "object" && address ? address.port : port;
  console.log(`HoldSend notes example: http://localhost:${shown} (${notes.databaseLabel})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    void notes.close().finally(() => process.exit(0));
  });
}
