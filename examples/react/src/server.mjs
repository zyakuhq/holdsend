// The React notes example: the notes example's server, serving this page.
//
// Run from the repository root:
//   npm install && npm run build && npm start --workspace holdsend-example-react
import { fileURLToPath } from "node:url";
import { createNotesApp } from "../../notes/src/app.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const notes = await createNotesApp({
  databaseUrl: process.env.DATABASE_URL,
  page: { entry: here("./main.jsx"), html: here("../public/index.html") },
});
const server = notes.app.listen(port, () => {
  const address = server.address();
  const shown = typeof address === "object" && address ? address.port : port;
  console.log(`HoldSend notes in React: http://localhost:${shown} (${notes.databaseLabel})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    void notes.close().finally(() => process.exit(0));
  });
}
