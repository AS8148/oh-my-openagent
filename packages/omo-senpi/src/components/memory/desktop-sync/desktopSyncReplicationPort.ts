import * as Schema from "effect/Schema";
import {
  DesktopSyncServiceError,
  SyncInteger,
  requireSyncSuccess,
  syncJson,
} from "./desktopSyncPortSchema.ts";
import type { SyncServiceCall } from "./desktopSyncAccountPorts.ts";

const stateSchema = Schema.Struct({
  head: Schema.Struct({ seq: SyncInteger }),
  oldest_retained_seq: SyncInteger,
  snapshot: Schema.NullOr(
    Schema.Struct({
      covers_seq: SyncInteger,
      chunk_object_ids: Schema.Array(Schema.String),
    }),
  ),
});
const pullReply = Schema.decodeUnknownSync(
  Schema.Struct({
    state: stateSchema,
    batches: Schema.Struct({
      entries: Schema.Array(
        Schema.Struct({
          seq: SyncInteger,
          kind: Schema.Literals(["batch", "keyring"]),
          author: Schema.Struct({ kind: Schema.String, id: Schema.String }),
          digest: Schema.String,
          object_id: Schema.NullOr(Schema.String),
          batch_id: Schema.NullOr(Schema.String),
        }),
      ),
    }),
    limit: SyncInteger,
  }),
);
const appendRequest = Schema.Struct({
  uploadId: Schema.String,
  digest: Schema.String,
  baseSeq: SyncInteger,
  batchId: Schema.String,
  epoch: SyncInteger,
  link: Schema.String,
  recordSig: Schema.String,
});

const decodeSequence = Schema.decodeUnknownSync(Schema.Struct({ seq: SyncInteger }));
const decodeReservation = Schema.decodeUnknownSync(Schema.Struct({ upload_id: Schema.String }));
const decodeState = Schema.decodeUnknownSync(stateSchema);

export function desktopSyncReplicationPort(
  call: SyncServiceCall,
  subscribe: (handlers: {
    readonly onAdvanced: (head: number) => void;
    readonly onConnected: (connected: boolean) => void;
  }) => () => void,
) {
  const json = async (request: Readonly<Record<string, unknown>>) => syncJson(await call(request));
  return {
    async pull(after: number, limit: number) {
      const first = pullReply(await json({ op: "pull", after, limit }));
      const state = first.state;
      const snapshot =
        state.snapshot !== null && after < state.oldest_retained_seq - 1
          ? {
              coversSeq: state.snapshot.covers_seq,
              objectIds: state.snapshot.chunk_object_ids,
              digest: null,
            }
          : null;
      const from = snapshot === null ? after : Math.max(after, snapshot.coversSeq);
      const page =
        from === after ? first : pullReply(await json({ op: "pull", after: from, limit }));
      const rows = page.batches.entries.slice(0, limit);
      const last = rows.at(-1)?.seq ?? from;
      return {
        snapshot,
        head: Math.max(state.head.seq, last),
        more: last < state.head.seq,
        entries: rows.map((row) => {
          const digest = Buffer.from(row.digest, "base64url");
          if (digest.length !== 32 || digest.toString("base64url") !== row.digest)
            throw new DesktopSyncServiceError("malformed_reply", 200);
          return {
            seq: row.seq,
            kind: row.kind,
            batchId: row.batch_id,
            digest: digest.toString("hex"),
            objectId: row.object_id ?? "",
            author: `${row.author.kind}:${row.author.id}`,
          };
        }),
      };
    },
    async download(objectId: string) {
      const response = requireSyncSuccess(await call({ op: "download", objectId }));
      if (response.kind !== "bytes")
        throw new DesktopSyncServiceError("malformed_reply", response.status);
      return response.bytes;
    },
    async reserve(size: number, digest: string) {
      return decodeReservation(
        await json({ op: "reserve", size, digest }),
      ).upload_id;
    },
    async upload(uploadId: string, ciphertext: Uint8Array) {
      await json({ op: "upload", uploadId, ciphertext });
    },
    async append(request: typeof appendRequest.Type) {
      try {
        return {
          ok: true as const,
          seq: decodeSequence(
            await json({ op: "append", request }),
          ).seq,
        };
      } catch (error) {
        if (!(error instanceof DesktopSyncServiceError) || error.code !== "stale_base") throw error;
        const state = decodeState(await json({ op: "state" }));
        return { ok: false as const, error: "stale_base" as const, head: state.head.seq };
      }
    },
    subscribe,
  };
}
