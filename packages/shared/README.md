# @volthub/shared — validation + state-machine contract

Zero-dependency runtime shared by api/worker/simulator: roles, connector/session/
reservation states, `vRegister`/`vReservation` (BR-04 15–120 min window)/
`vVehicle`, and the transition matrix (`LEGAL`) that both the PL/SQL package and
the API enforce — one source of truth for "what moves are legal".
