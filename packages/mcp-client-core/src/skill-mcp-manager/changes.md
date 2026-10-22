## 2026-10-22 - Preserve notice state across reconnects (#10693)

The manager reuses its environment policy after disconnectAll, so closing its
watcher preserves bounded pending handles and notice deduplication. Ambient token
rotation still rematerializes the environment without repeating an unchanged
notice. The existing authority test exposed and verifies this regression.

## 2026-10-22 - Identify both vendored grant-store sources (#10693)

The header names senpi c7ac4b1a86 for formatting and 1cbe1594e for the Windows
rename-retry hunk. No runtime behavior changes.

## 2026-10-22 - Bound pending environment grant handles (#10693)

A replacement notice invalidates previous handles for the declaration. At most
128 handles are retained; evicted identities can issue a fresh notice. A grant
rechecks handle validity after asynchronous declaration validation before writing.
