## 2026-10-22 - Identify both vendored grant-store sources (#10693)

The header names senpi c7ac4b1a86 for formatting and 1cbe1594e for the Windows
rename-retry hunk. No runtime behavior changes.

## 2026-10-22 - Bound pending environment grant handles (#10693)

A replacement notice invalidates previous handles for the declaration. At most
128 handles are retained; evicted identities can issue a fresh notice. A grant
rechecks handle validity after asynchronous declaration validation before writing,
and closing the policy drops all pending handles.
