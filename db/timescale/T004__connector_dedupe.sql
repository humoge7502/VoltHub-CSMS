-- ============================================================================
-- VoltHub CSMS — TimescaleDB T004: connector_state_event dedupe key
--
-- Why: the relay writes state transitions with INSERT ... ON CONFLICT DO NOTHING
-- (ADR-0003 at-least-once). Its only key was (connector_ref, ts) with ts truncated
-- to whole seconds, so two DIFFERENT transitions of one connector inside the same
-- second collided — the second was dropped in silence, and utilization/uptime in
-- T002 was computed from a history that had lost the flap. Fresh installs get the
-- key from T001; this file upgrades databases created before it.
--
-- Idempotent: scripts/migrate.sh re-applies every T0*.sql on every run.
-- ============================================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'connector_state_event' AND column_name = 'dedupe_key'
  ) THEN
    ALTER TABLE connector_state_event ADD COLUMN dedupe_key TEXT;
  END IF;
END $$;

-- Rows that predate the relay key get a deterministic identity from the old primary
-- key itself, so the NOT NULL below can never be violated by a re-run of this file.
UPDATE connector_state_event
   SET dedupe_key = 'legacy:' || md5(connector_ref || '|' || ts::text)
 WHERE dedupe_key IS NULL;

ALTER TABLE connector_state_event ALTER COLUMN dedupe_key SET NOT NULL;
-- Deploy ordering. A relay build that predates this migration does not send the
-- column, and a bare NOT NULL would then fail EVERY state insert — the batch rolls
-- back and even the healthy meter_tick rows stop landing, so applying the schema
-- before the code looks like it broke the pipeline. A DEFAULT keeps the old writer
-- working exactly as before (one row per connector per second) while the new writer
-- gets the key it needs. The default is dropped once every relay is upgraded.
ALTER TABLE connector_state_event ALTER COLUMN dedupe_key SET DEFAULT '';

DO $$
DECLARE
  cols TEXT;
BEGIN
  SELECT string_agg(a.attname, ',' ORDER BY array_position(i.indkey, a.attnum))
    INTO cols
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
   WHERE c.relname = 'connector_state_event' AND i.indisprimary;

  IF cols IS DISTINCT FROM 'connector_ref,ts,dedupe_key' THEN
    -- Timescale requires every unique index on a hypertable to contain the
    -- partitioning column; ts stays first-class in the new key for that reason.
    ALTER TABLE connector_state_event DROP CONSTRAINT IF EXISTS connector_state_event_pkey;
    ALTER TABLE connector_state_event ADD PRIMARY KEY (connector_ref, ts, dedupe_key);
  END IF;
END $$;
