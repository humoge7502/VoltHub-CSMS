-- Invariants: CI runs each SELECT; any returned row = FAIL (masterplan §33).
-- 1. No overlapping BOOKED/CONVERTED reservations (BR-05):
SELECT r1.reservation_id AS a, r2.reservation_id AS b FROM reservation r1
JOIN reservation r2 ON r2.connector_ref=r1.connector_ref AND r2.reservation_id>r1.reservation_id
 AND r2.status IN ('BOOKED','CONVERTED') AND r1.status IN ('BOOKED','CONVERTED')
 AND r2.start_at < r1.end_at AND r2.end_at > r1.start_at;
-- 2. Ledger reconciles: balance == SUM(ledger) (expect 0 rows):
SELECT w.user_id FROM wallet_account w
WHERE w.balance != NVL((SELECT SUM(amount) FROM wallet_ledger l WHERE l.user_id=w.user_id),0);
-- 3. BILLED invoice => COMPLETED session (expect 0 rows):
SELECT i.invoice_id FROM invoice i JOIN charging_session cs ON cs.session_id=i.session_id
WHERE i.status IN ('PAID','DUE') AND cs.state != 'COMPLETED';
-- 4. PAID total == SUM(lines) (expect 0 rows):
SELECT i.invoice_id FROM invoice i WHERE i.status='PAID'
AND i.total != (SELECT NVL(SUM(amount),0) FROM invoice_line l WHERE l.invoice_id=i.invoice_id);
-- 5. Meter monotonic per session (expect 0 rows):
SELECT m1.session_id, m1.seq_no FROM meter_reading m1
JOIN meter_reading m2 ON m2.session_id=m1.session_id AND m2.seq_no=m1.seq_no-1
WHERE m1.meter_kwh < m2.meter_kwh - 0.001;
-- 6. One review per session enforced by UNIQUE (expect 0 rows):
SELECT session_id, COUNT(*) FROM review GROUP BY session_id HAVING COUNT(*) > 1;
-- 7. PAID invoice has >=1 SUCCESS payment; no PAID invoice on FAILED-only history (expect 0 rows):
SELECT i.invoice_id FROM invoice i WHERE i.status='PAID'
 AND NOT EXISTS (SELECT 1 FROM payment p WHERE p.invoice_id=i.invoice_id AND p.status='SUCCESS');
-- 8. D-07(b): balance_after chain continuity per user (expect 0 rows):
SELECT l1.user_id, l1.seq_no FROM wallet_ledger l1
 JOIN wallet_ledger l2 ON l2.user_id=l1.user_id AND l2.seq_no=l1.seq_no-1
 WHERE l1.seq_no > 1 AND l2.seq_no IS NULL;
-- 9. D-07(c)/B2G-004: no invoice FAILED (failed PAYMENTS are the record; invoices stay DUE) (expect 0 rows):
SELECT invoice_id FROM invoice WHERE status='FAILED';
-- 10. D-07 extra: no BILLED session without COMPLETED state mirrored (expect 0 rows):
SELECT session_id FROM charging_session WHERE billing_state='BILLED' AND state NOT IN ('COMPLETED','CANCELLED');
