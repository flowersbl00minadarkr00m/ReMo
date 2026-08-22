# Privacy and trust boundary

ReMo treats evidence collection as an authority problem, not just a recording problem.

## Complete local product

- Operational state stays on the machine in local SQLite and content-addressed storage.
- The browser interface talks to an exact loopback origin; arbitrary remote origins are rejected.
- Capture is bounded to configured surfaces and privacy-checked before durable promotion.
- Credentials, private paths, mismatched evidence, and failed verification cannot be promoted as a trustworthy save point.
- Git mutation is explicit, confirmed, and limited to the reviewed branch/worktree operation.

## Hosted demonstration

- All displayed data is purpose-built synthetic evidence.
- No repository, credential, upload, analytics, cookie, local service, private API, or third-party data channel is used.
- Branching is simulated in browser-session state and is labeled at both the action and result.
- Missing or corrupt fixture media produces an unavailable state with recovery; it is never replaced with fabricated evidence.

The hosted demonstration is useful for evaluating the workflow. It is not evidence that a real local operation occurred.
