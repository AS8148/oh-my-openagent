import * as Schema from "effect/Schema";

export class DesktopSyncRefused extends Error {
  override readonly name = "DesktopSyncRefused";
  constructor() {
    super("The private desktop sync channel is unavailable or retired.");
  }
}

const id = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(0x7fffffff));
const token = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const DesktopSyncRequest = Schema.Union([
  Schema.Struct({ op: Schema.Literals(["descriptor", "operationBegin", "capability"]) }),
  Schema.Struct({ op: Schema.Literals(["operationCancel", "operationEnd"]), handle: token }),
  Schema.Struct({
    op: Schema.Literals(["service", "keyring", "genesisRun"]),
    handle: token,
    data: Schema.Unknown,
  }),
]);
export type DesktopSyncRequest = typeof DesktopSyncRequest.Type;

export const DesktopSyncPacket = Schema.Union([
  Schema.Struct({
    id,
    op: Schema.Literal("authenticate"),
    binding: Schema.Struct({ instanceId: token, token }),
  }),
  Schema.Struct({ id, op: Schema.Literal("register") }),
  Schema.Struct({ id, op: Schema.Literal("retire"), child: token }),
  Schema.Struct({ id, op: Schema.Literal("call"), child: token, request: DesktopSyncRequest }),
]);
export const DesktopSyncReply = Schema.Union([
  Schema.Struct({ id, ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ id, ok: Schema.Literal(false), reason: Schema.Literal("refused") }),
]);
export const decodeSyncPacket = Schema.decodeUnknownSync(DesktopSyncPacket, {
  onExcessProperty: "error",
});
export const decodeSyncReply = Schema.decodeUnknownSync(DesktopSyncReply, {
  onExcessProperty: "error",
});
export const decodeSyncHandle = Schema.decodeUnknownSync(Schema.Struct({ handle: token }), {
  onExcessProperty: "error",
});
export const decodeSyncChild = Schema.decodeUnknownSync(Schema.Struct({ child: token }), {
  onExcessProperty: "error",
});
export const DesktopSyncEvent = Schema.Union([
  Schema.Struct({ event: Schema.Literal("retired"), child: token }),
  Schema.Struct({
    event: Schema.Literal("advanced"),
    child: token,
    handle: token,
    head: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    event: Schema.Literal("connected"),
    child: token,
    handle: token,
    connected: Schema.Boolean,
  }),
]);
export type DesktopSyncEvent = typeof DesktopSyncEvent.Type;
export const decodeSyncEvent = Schema.decodeUnknownSync(DesktopSyncEvent, {
  onExcessProperty: "error",
});

export interface DesktopSyncAuthority {
  readonly signal: AbortSignal;
  admit<T>(effect: () => T): T;
}

export interface DesktopSyncWire {
  /** Must synchronously write to the authenticated transport before returning the Promise. */
  request(request: DesktopSyncRequest): Promise<unknown>;
}

export interface DesktopSyncBootstrap {
  readonly endpoint: string;
  readonly binding: { readonly instanceId: string; readonly token: string };
}
export type DesktopSyncBootstrapState =
  | DesktopSyncBootstrap
  | { readonly unavailable: "platform transport not implemented" };
