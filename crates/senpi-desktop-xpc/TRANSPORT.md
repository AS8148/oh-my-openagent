# Inactive O2 transport

`senpi-desktop-engine --xpc-agent <mach-service>` is an opt-in macOS 13+
listener. The flag must be first. It installs no job, is not selected by any
existing client, and cannot be combined with another engine mode. All legacy
launches still pass the responsibility gate. The only eligible requester is
O1's native-controller role; Electron main remains ineligible.

## Handshake and framing

Every received dictionary is checked against its actual XPC sender using O1
before decoding fields or JSON. Both listeners install O1's requirement and
their event handlers before activation. A failed requirement aborts startup.
The listener also checks peer EUID against its own EUID.

1. Named discovery sends exactly `version: uint64(1)` and `challenge: data(32)`
   using a fresh CSPRNG challenge. The reciprocal server requirement must be
   installed before activation. The reply must pass O1's server verification,
   echo the challenge and carry `epoch: data("xpc-1")` and an `endpoint`.
2. Connect to that anonymous endpoint, install the reciprocal requirement, and
   repeat the public challenge. Its authenticated reply advertises
   `max_request_bytes` (1 MiB), `max_response_bytes` (128 MiB), and
   `max_approval_frames` (64). The response bound covers sixteen current inline
   capture budgets after base64 expansion plus JSON/AX headroom, rounded upward.
3. After the trusted native UI approves a finite immutable batch, send an
   approval dictionary: `version: 1`, `kind: 1`, `hashes: data` containing up to
   64 concatenated SHA-256 hashes of the exact upcoming NDJSON frames, and
   `ttl_ms: uint64` in 1..60000. This is an authenticated controller assertion,
   never a proposal-source `approved` boolean. O3 supplies that UI; O2 does not.
   A batch cannot replace another unfinished batch.
4. The authenticated approval reply carries `kind: 1` and the connection's
   CSPRNG 256-bit `capability`. Send data dictionaries with exactly `version`,
   `kind: 2`, `capability`, `sequence: uint64`, and `payload: data`. Sequences
   start at 1 and increase by one. Approval consumes the next exact frame hash.
   JSON-RPC payloads and request IDs are unchanged. Replies and notifications
   use the same envelope with an independent monotonically increasing sequence.

Neither discovery connection carries tokens, approval, or RPC. An error,
interruption, invalid frame, stale capability, wrong sequence, expired approval,
or identity refusal closes that live connection. There is no reconnect or replay
path. A new engine instance requires fresh discovery and fresh approval.

## Session ownership

Backend construction waits for an authenticated, approved, structurally valid
`session.open`; `engine.hello` needs no backend. Each connection owns its Engine,
outbox, IDs, cancellation and resume token. Physical input arbitration and the
native stop listener are process-wide. Disconnect cancels queued/in-flight
requests, releases held input, and closes only that session. Client deadlines
never terminate the agent.

The shared stop latch cannot be cleared with a connection's `stopPath.resume`.
Restarting revokes connections and requires fresh approval, but never clears a
user stop. O2 has no reset RPC or persistent-marker deletion operation. Only a
future explicit user action through the signed O3 controller or desktop app may
lift it; a connection's resume token cannot become global reset authority.

## Durable user stop

The agent resolves its effective UID's home from the OS account database, not
`HOME`, and uses
`~/Library/Application Support/OmO/ComputerControl/xpc-v1/global-stop`.
The private `xpc-v1` directory is created with mode 0700 and must belong to that
UID. The marker must be a regular, non-symlink file owned by the same UID with
mode 0600 and the exact bytes `omo-global-stop-v1\n`. There is no production
environment variable, command-line option or feature flag for changing this
location.

The agent loads the marker before activating either listener. A missing marker
means not stopped. An unreadable or malformed marker, wrong owner or permission
bits, symlink, non-regular file, or invalid private directory starts the agent
stopped and logs the reason. No session or backend is needed for restoration.

All stop sources, including the native hotkey, pass through the shared
supervisor's commit boundary. It creates a same-directory, exclusive 0600 temp
file, writes the marker, fsyncs the file, renames it atomically, and fsyncs the
directory. Newly created directory entries are also synced through their
parents. Only then may the stop epoch, suspended flag, held-input notifications
or RPC acknowledgement be published. A durable-write failure is logged and
terminates the XPC agent without acknowledging the stop or continuing to accept
input. Legacy engine modes retain their existing in-memory stop behavior.

## Manual acceptance

`TMPDIR=/tmp/cu10207 bash crates/senpi-desktop-xpc/scripts/signed-transport.sh`
builds real binaries, signs temporary bundles, and exercises a task-owned GUI
Mach service. It covers valid/unauthorized/old-epoch requesters, squatting,
anonymous endpoint invalidation, fresh reconnect and stale-capability rejection.
The trap boots out only its exact random labels and removes its fixture files.
It neither installs a permanent LaunchAgent nor changes TCC grants.

`TMPDIR=/tmp/cu10207 bash crates/senpi-desktop-xpc/scripts/signed-latch.sh`
signs the engine's `cfg(test)` process harness and uses the real `--xpc-agent`
dispatcher and O1 verifier. Only that test build accepts an isolated state path
and uses fake input hardware. The proof observes the startup state before any
client, acknowledges a stop, SIGKILLs the process, and restarts on the same
directory. It then requires stopped before and after a new authenticated client,
`Suspended` for input, and refusal of RPC reset. FIFO startup events replace
timing sleeps; the trap verifies job/process/fixture teardown.
