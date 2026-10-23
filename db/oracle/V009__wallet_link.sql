-- ============================================================================
-- V009 — ADR-0016: wallet links (signed wallet rail)
--
-- A link is the durable half of the rail: the public address that a driver proved
-- they control with an EIP-191 signature. Signatures, challenges and top-up intents
-- are deliberately NOT stored here — they are short-lived authorisations (5/10 min)
-- and the ledger is the settlement of record.
--
-- No DELETE: the runtime role has no DELETE anywhere (V004 least-privilege). An
-- unlink is a revoked_at stamp, so the audit trail keeps the address that once had
-- authority instead of forgetting it.
-- ============================================================================

CREATE TABLE wallet_link (
  link_id     NUMBER PRIMARY KEY,
  user_id     NUMBER NOT NULL REFERENCES app_user(user_id),
  address     VARCHAR2(42) NOT NULL,
  address_lc  VARCHAR2(42) NOT NULL,
  chain_id    NUMBER NOT NULL,
  label       VARCHAR2(60),
  verified_by VARCHAR2(16) DEFAULT 'EIP-191' NOT NULL,
  linked_at   TIMESTAMP(6) DEFAULT SYSTIMESTAMP NOT NULL,
  revoked_at  TIMESTAMP(6)
);

-- One address may be linked to one account at a time; a revoked link frees it again.
-- Function-based unique index because Oracle has no partial indexes.
CREATE UNIQUE INDEX uq_wallet_link_active ON wallet_link (
  CASE WHEN revoked_at IS NULL THEN address_lc END
);

CREATE INDEX ix_wallet_link_user ON wallet_link (user_id);

COMMENT ON TABLE wallet_link IS 'ADR-0016: EIP-191-verified wallet addresses; append-only (revoke, never delete)';
COMMENT ON COLUMN wallet_link.address IS 'EIP-55 checksummed address as displayed to the user';
COMMENT ON COLUMN wallet_link.address_lc IS 'lowercase form — the uniqueness/join key';
COMMENT ON COLUMN wallet_link.revoked_at IS 'NULL = active link; stamped on unlink (no DELETE grant)';

COMMIT;
