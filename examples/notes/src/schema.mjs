// Shared schema for the Notes example.
export const NOTES_SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id         BIGSERIAL PRIMARY KEY,
  owner      TEXT NOT NULL,
  text       TEXT NOT NULL,
  written_at TIMESTAMPTZ,
  arrived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_owner_arrived_idx ON notes (owner, arrived_at DESC);
CREATE TABLE IF NOT EXISTS emergency_messages (
  id         BIGSERIAL PRIMARY KEY,
  owner      TEXT NOT NULL,
  text       TEXT NOT NULL,
  written_at TIMESTAMPTZ,
  arrived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS emergency_owner_arrived_idx ON emergency_messages (owner, arrived_at DESC);
`;
