import * as Schema from "effect/Schema";

export const SyncInteger = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const SyncPrincipal = Schema.Struct({
  kind: Schema.Literal("device"),
  id: Schema.String,
  signing_public_key: Schema.String,
  sealing_public_key: Schema.String,
});
const author = Schema.Union([
  SyncPrincipal,
  Schema.Struct({ kind: Schema.Literal("recovery"), credential_id: Schema.String }),
]);
export const SyncWrap = Schema.Struct({
  epoch: SyncInteger,
  id: Schema.String,
  wrap: Schema.String,
});
export const SyncChainRow = Schema.Struct({
  seq: SyncInteger,
  base_seq: SyncInteger,
  kind: Schema.Literals(["batch", "keyring"]),
  account: Schema.String,
  epoch: SyncInteger,
  author,
  digest: Schema.String,
  link: Schema.String,
  keyring_link: Schema.NullOr(Schema.String),
  record_sig: Schema.String,
});
const keyringRow = Schema.Struct({
  ...SyncChainRow.fields,
  kind: Schema.Literal("keyring"),
  keyring_link: Schema.String,
  body: Schema.Record(Schema.String, Schema.Json),
  wraps: Schema.Array(SyncWrap),
});
const bodyFields = Schema.Struct({
  kind: Schema.String,
  account: Schema.String,
  epoch: SyncInteger,
});
const decodeKeyRows = Schema.decodeUnknownSync(Schema.Struct({ entries: Schema.Array(keyringRow) }));
const decodeBody = Schema.decodeUnknownSync(bodyFields);
export const decodeSyncKeys = (input: unknown) =>
  decodeKeyRows(input).entries.map(
    (entry) => ({
      ...entry,
      body: { ...entry.body, ...decodeBody(entry.body) },
    }),
  );
export const decodeSyncEntries = Schema.decodeUnknownSync(
  Schema.Struct({ entries: Schema.Array(SyncChainRow) }),
);
export const decodeRecoveryWraps = Schema.decodeUnknownSync(
  Schema.Struct({
    wraps: Schema.Array(
      Schema.Struct({
        record: Schema.Struct({
          seq: SyncInteger,
          digest: Schema.String,
          keyring_link: Schema.String,
        }),
        entry: SyncWrap,
      }),
    ),
  }),
);
export const SyncPending = Schema.Struct({
  id: Schema.String,
  account: Schema.String,
  commitment: Schema.String,
  answer: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        principal: SyncPrincipal,
        approver_nonce: Schema.String,
      }),
    ),
  ),
  reveal: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        principal: SyncPrincipal,
        joining_nonce: Schema.String,
      }),
    ),
  ),
  expires_at: SyncInteger,
});
const decodePending = Schema.decodeUnknownSync(SyncPending);
export const decodeSyncPending = (input: unknown) => {
  const pending = decodePending(input);
  return { ...pending, answer: pending.answer ?? null, reveal: pending.reveal ?? null };
};
export const SyncDescriptor = Schema.Struct({
  genesis: Schema.Literals(["supported", "unsupported"]),
  rpId: Schema.NullOr(Schema.String),
  userName: Schema.NullOr(Schema.String),
  serviceOrigin: Schema.String,
  accountId: Schema.String,
  serviceDeviceId: Schema.String,
  syncPrincipalId: Schema.String,
  generation: Schema.String,
  publicKeys: Schema.Struct({ signing: Schema.String, sealing: Schema.String }),
});
export type SyncDescriptor = typeof SyncDescriptor.Type;
export const SyncDevices = Schema.Struct({
  devices: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      kind: Schema.Literals(["desktop", "cli"]),
      platform: Schema.Literals(["macos", "linux", "windows"]),
      createdAt: Schema.String,
      lastSeenAt: Schema.String,
      approximateLocation: Schema.optionalKey(Schema.String),
      current: Schema.Boolean,
      syncing: Schema.Boolean,
      revokedAt: Schema.NullOr(Schema.String),
      syncPrincipal: Schema.NullOr(Schema.String),
    }),
  ),
});
const reply = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("json"), status: SyncInteger, body: Schema.Unknown }),
  Schema.Struct({ kind: Schema.Literal("bytes"), status: SyncInteger, bytes: Schema.Uint8Array }),
]);
export const decodeSyncServiceReply = Schema.decodeUnknownSync(reply, {
  onExcessProperty: "error",
});

export class DesktopSyncServiceError extends Error {
  override readonly name = "DesktopSyncServiceError";
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(`Desktop sync service refused the request (${status}).`);
    this.code = code;
    this.status = status;
  }
}
const errorCode = Schema.decodeUnknownOption(
  Schema.Struct({
    error: Schema.Struct({ code: Schema.String }),
  }),
);
export function requireSyncSuccess(input: unknown) {
  const response = decodeSyncServiceReply(input);
  if (response.status < 200 || response.status >= 300) {
    const parsed = response.kind === "json" ? errorCode(response.body) : undefined;
    const code = parsed?._tag === "Some" ? parsed.value.error.code : "unknown";
    throw new DesktopSyncServiceError(
      response.status >= 500 ? "unavailable" : code,
      response.status,
    );
  }
  return response;
}
export function syncJson(input: unknown): unknown {
  const response = requireSyncSuccess(input);
  if (response.kind !== "json")
    throw new DesktopSyncServiceError("malformed_reply", response.status);
  return response.body;
}
