import * as Schema from "effect/Schema";
import {
  decodeRecoveryWraps,
  decodeSyncEntries,
  decodeSyncKeys,
  decodeSyncPending,
  DesktopSyncServiceError,
  SyncDevices,
  SyncInteger,
  SyncPending,
  SyncWrap,
  syncJson,
  type SyncDescriptor,
  type SyncPrincipal,
} from "./desktopSyncPortSchema.ts";

export type SyncServiceCall = (request: Readonly<Record<string, unknown>>) => Promise<unknown>;
const decodePendingList = Schema.decodeUnknownSync(Schema.Struct({ pending: Schema.Array(SyncPending) }));
const decodeDevices = Schema.decodeUnknownSync(SyncDevices);
const appendReply = Schema.decodeUnknownSync(Schema.Struct({ seq: SyncInteger }));
const appendRequest = Schema.Struct({
  record: Schema.Record(Schema.String, Schema.Json),
  base_seq: SyncInteger,
  link: Schema.String,
  keyring_link: Schema.String,
  record_sig: Schema.String,
  wraps: Schema.Array(SyncWrap),
});
const stateReply = Schema.decodeUnknownSync(
  Schema.Struct({
    head: Schema.Struct({ seq: SyncInteger, link: Schema.String, keyring_link: Schema.String }),
    current_epoch: SyncInteger,
    rotation_pending: Schema.Boolean,
  }),
);

/** Native chain/pairing values, not a fake HTTP adapter or a fabricated bearer. */
export function desktopSyncAccountPorts(call: SyncServiceCall, descriptor: SyncDescriptor) {
  const json = async (request: Readonly<Record<string, unknown>>) => syncJson(await call(request));
  const append = async (op: "appendKeys" | "recoveryJoin", request: typeof appendRequest.Type) => {
    try {
      return { ok: true as const, seq: appendReply(await json({ op, request })).seq };
    } catch (error) {
      if (!(error instanceof DesktopSyncServiceError) || error.status >= 500) throw error;
      switch (error.code) {
        case "stale_base":
        case "rate_limited":
        case "not_found":
          return { ok: false as const, reason: error.code };
        default:
          return { ok: false as const, reason: "refused" as const };
      }
    }
  };
  return {
    chain: {
      listKeys: async () => decodeSyncKeys(await json({ op: "listKeys" })),
      listEntries: async () => decodeSyncEntries(await json({ op: "listEntries" })).entries,
      listEntriesAfter: async (after: number) =>
        decodeSyncEntries(await json({ op: "listEntriesAfter", after })).entries,
      listRecoveryWraps: async () =>
        decodeRecoveryWraps(await json({ op: "listRecoveryWraps" })).wraps,
      async state() {
        const state = stateReply(await json({ op: "state" }));
        return {
          head: state.head,
          currentEpoch: state.current_epoch,
          rotationPending: state.rotation_pending,
        };
      },
      appendKeys: (request: typeof appendRequest.Type) => append("appendKeys", request),
      recoveryJoin: (request: typeof appendRequest.Type) => append("recoveryJoin", request),
    },
    pairing: {
      async openPending(account: string, commitment: string) {
        if (account !== descriptor.accountId) throw new DesktopSyncServiceError("refused", 403);
        return decodeSyncPending(await json({ op: "openPending", commitment }));
      },
      async readPending(id: string) {
        try {
          return decodeSyncPending(await json({ op: "readPending", id }));
        } catch (error) {
          if (error instanceof DesktopSyncServiceError && error.code === "not_found") return null;
          throw error;
        }
      },
      async listPending() {
        const { pending } = decodePendingList(await json({ op: "listPending" }));
        return pending.map(decodeSyncPending);
      },
      answerPending: async (id: string, principal: typeof SyncPrincipal.Type, nonce: string) =>
        decodeSyncPending(await json({ op: "answerPending", id, principal, nonce })),
      revealPending: async (id: string, principal: typeof SyncPrincipal.Type, nonce: string) =>
        decodeSyncPending(await json({ op: "revealPending", id, principal, nonce })),
      async setAccountSync(enabled: boolean) {
        await json({ op: "setAccountSync", enabled });
      },
      async setDeviceSync(deviceId: string, enabled: boolean) {
        if (deviceId !== descriptor.serviceDeviceId)
          throw new DesktopSyncServiceError("refused", 403);
        await json({ op: "setDeviceSync", enabled });
      },
    },
    devices: async () =>
      decodeDevices(await json({ op: "devices" })).devices,
  };
}
