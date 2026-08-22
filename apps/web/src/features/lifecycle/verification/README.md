# T7 lifecycle visual verification

These are actual headless Chromium captures from the supported loopback service, React UI, SQLite catalog, and content-addressed storage path at fake time `2026-08-16T13:00:00.000Z`.

- `t7-lifecycle-desktop.png` (1440 x 1000 viewport, full page): `8A148664D9E6A01F0B4B90A0AA21AF863AD4EC8404CDF1A4B2C14FD60F8B3197`
- `t7-lifecycle-mobile.png` (390 x 844 viewport, full page): `9A64A89D2E533F6618EA9F62E6C907F1800C3C2061E88406B197F4AA78F1E0CC`

The desktop capture shows the unpinned durable retention state and lifecycle actions. The mobile capture shows the pinned state after a real lifecycle request, including the live success announcement. Reproduce them with `pnpm --dir apps/service exec tsx src/lifecycle/capture-lifecycle.ts`.
