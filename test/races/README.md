# test:races — R1 double-reserve + R4 double-pay (`apps/api/test/race.js`)

Two `Promise.allSettled` contenders, same connector/window and same invoice:
exactly one `201`, one `409`, one `BOOKED` row (Q25). The interview demo —
also runnable live via the simulator (`--scenario race`).
