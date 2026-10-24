# Agreement source events

`record_agreement` requires `source: { sessionId, messageId }`. Both values
come from the actual extraction payload: the queue entry's `sessionId` and a
user entry's `source_message_id`. Assistant messages and `lead` context cannot
supply an event. The adapter validates this before writing JSONL and again at
finalization. New payloads carry `agreementEventVersion: 1`; a record without
source in such a payload is invalid.

For each agreement, one source session/message pair counts once, regardless of
the number of tool calls, runs or batches that emit it. Distinct user turns on
the same date count separately. The date remains display metadata, not modern
event identity. Source IDs are never derived from agreement text or a tool call.

## Durable journal

The ledger holds an independent receipt journal in HTML comments of the form
`<!-- agreement-event: <sha256> -->`. A modern digest covers the version,
agreement ID, session ID and message ID, with JSON array encoding to avoid
separator ambiguity. The journal and the item mutation are one file, one
ownership-checked facts transaction and one Git commit. Receipts do not appear
in the compiled agreement prompt or the known-agreements extraction payload.

Acknowledgement resets the visible count but retains the journal. Drop and cap
eviction also retain it: an already-counted event cannot resurrect an item.
A distinct future turn can create that agreement again. Memory tools cannot
edit or remove the journal.

Repeated extraction adds no journal entries. Each accepted modern event adds
one fixed-size digest, plus a shared legacy-date digest. A `new` record matching
reworded text also retains that text's target ID as an alias for replay after drop.
The event identity still comes from the source session/message pair; no transcript
text is copied. The total retained history grows with distinct events. There
is deliberately no age-based pruning or fixed lifetime receipt cap: either
would allow an old event to count again, or require refusing new corrections.
The active agreement count remains bounded by the existing `maxItems` policy.

## Pre-upgrade artifacts

An identityless record is accepted only as legacy input and counts at most once
per agreement/date. Existing `last` dates seed legacy receipts, even after an
acknowledgement. Unknown historical dates cannot be recovered
from an old ledger. Distinct old corrections on one date cannot be distinguished
and collapse; distinct modern source turns never collapse.

Legacy JSONL keeps its old shape and hash. New recovery plans carry
`agreementEventVersion: 1`. When an old plan contains the agreement path, recovery
requires the original extraction records and an atomic envelope publisher.
It first verifies the original hash and pre/post ownership, renders a deduplicated
post-image from the original pre-image, restores owned old residue, publishes the
upgraded envelope, and only then applies the new post-image. A restart before
publication recognizes the old pre-state; after publication it recognizes the
new pre/post-state. Other paths in the batch retain their recorded post-images.
Already-committed old batches keep their batch receipt and are not applied again.
