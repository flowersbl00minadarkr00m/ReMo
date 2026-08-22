# S-004 qualified basic comparison evidence

`verify-s004.mjs` runs the production web build and local application against the deterministic ten-save fixture. By default it writes to a new operating-system temporary directory and prints that path. It refreshes only this directory's committed T6 evidence when `REMO_REFRESH_S004_EVIDENCE=1` is explicitly set.

The matrix contains matched, deliberate fixture-mismatch, and deleted-side degraded states at 320, 390, 768, 1024, and 1440 CSS pixels. The ledger keeps fixture context overrides labeled `simulated` / `fixture-contract`; they do not upgrade production claims.
