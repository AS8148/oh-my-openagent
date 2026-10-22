## 2026-10-22 - Bound pending environment grant handles (#10693)

A replacement notice invalidates previous handles for the declaration. At most
128 handles are retained; evicted identities can issue a fresh notice. A grant
rechecks handle validity after asynchronous declaration validation before writing,
and closing the policy drops all pending handles.
