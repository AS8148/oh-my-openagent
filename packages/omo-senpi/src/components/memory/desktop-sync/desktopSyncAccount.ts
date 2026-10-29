import * as Schema from "effect/Schema";
import { desktopSyncAccountPorts } from "./desktopSyncAccountPorts.ts";
import { desktopSyncReplicationPort } from "./desktopSyncReplicationPort.ts";
import { SyncDescriptor, DesktopSyncServiceError } from "./desktopSyncPortSchema.ts";
import { openDesktopSyncOperation } from "./desktopSyncOperation.ts";
import {
  DesktopSyncRefused,
  type DesktopSyncAuthority,
  type DesktopSyncEvent,
  type DesktopSyncWire,
} from "./desktopSyncProtocol.ts";

const decodeDescriptor = Schema.decodeUnknownSync(SyncDescriptor);

type EngineWire = DesktopSyncWire & {
  readonly signal: AbortSignal;
  close(): void;
  onEvent(listener: (event: DesktopSyncEvent) => void): () => void;
};
type SignRequest =
  | { readonly purpose: "object-digest"; readonly digest: Uint8Array }
  | { readonly purpose: "record" | "snapshot"; readonly canonicalJson: Uint8Array };
const decodeSignature = Schema.decodeUnknownSync(
  Schema.Struct({
    op: Schema.Literal("sign"),
    signature: Schema.String,
  }),
  { onExcessProperty: "error" },
);
const decodeUnsealed = Schema.decodeUnknownSync(
  Schema.Struct({
    op: Schema.Literal("unseal"),
    plaintext: Schema.String,
  }),
  { onExcessProperty: "error" },
);
const bytes = (value: string, length?: number) => {
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value ||
    (length !== undefined && decoded.length !== length)
  )
    throw new DesktopSyncServiceError("malformed_reply", 200);
  return new Uint8Array(decoded);
};

/** Install this source in the engine's composition root, not the CLI credential source. */
export async function openDesktopSyncAccount(wire: EngineWire) {
  const descriptor = decodeDescriptor(
    await wire.request({ op: "descriptor" }),
  );
  const accountAuthority: DesktopSyncAuthority = {
    signal: wire.signal,
    admit(effect) {
      if (wire.signal.aborted) throw new DesktopSyncRefused();
      return effect();
    },
  };
  const forOperation = async (authority: DesktopSyncAuthority) => {
    const operation = await openDesktopSyncOperation(wire, {
      signal: AbortSignal.any([wire.signal, authority.signal]),
      admit: (effect) => accountAuthority.admit(() => authority.admit(effect)),
    });
    const call = (data: Readonly<Record<string, unknown>>) =>
      operation.request({ op: "service", data });
    return {
      ...desktopSyncAccountPorts(call, descriptor),
      handle: operation.handle,
      call,
      close: operation.close,
      keyring: {
        principal: () => ({ kind: "device" as const, id: descriptor.syncPrincipalId }),
        publicKeys: () => descriptor.publicKeys,
        async sign(request: SignRequest) {
          const data =
            request.purpose === "object-digest"
              ? {
                  op: "sign",
                  purpose: request.purpose,
                  digest: Buffer.from(request.digest).toString("base64url"),
                }
              : {
                  op: "sign",
                  purpose: request.purpose,
                  canonicalJson: Buffer.from(request.canonicalJson).toString("base64url"),
                };
          return bytes(
            decodeSignature(await operation.request({ op: "keyring", data })).signature,
            64,
          );
        },
        async unseal(
          wrap: Uint8Array,
          binding: { readonly account: string; readonly epoch: number; readonly id: string },
        ) {
          if (binding.account !== descriptor.accountId) throw new DesktopSyncRefused();
          const reply = decodeUnsealed(
            await operation.request({
              op: "keyring",
              data: { op: "unseal", wrap: Buffer.from(wrap).toString("base64url"), binding },
            }),
          );
          return bytes(reply.plaintext);
        },
      },
    };
  };
  const background = await forOperation(accountAuthority);
  const transport = desktopSyncReplicationPort(background.call, (handlers) => {
    let active = true;
    let subscription: Awaited<ReturnType<typeof forOperation>> | undefined;
    const remove = wire.onEvent((event) => {
      if (
        !active ||
        wire.signal.aborted ||
        event.event === "retired" ||
        event.handle !== subscription?.handle
      )
        return;
      switch (event.event) {
        case "advanced":
          handlers.onAdvanced(event.head);
          break;
        case "connected":
          handlers.onConnected(event.connected);
          break;
      }
    });
    void forOperation(accountAuthority)
      .then(async (operation) => {
        subscription = operation;
        if (!active) return operation.close();
        await operation.call({ op: "subscribe" });
      })
      .catch(() => {
        if (active && !wire.signal.aborted) handlers.onConnected(false);
      });
    return () => {
      if (!active) return;
      active = false;
      remove();
      if (subscription !== undefined && !wire.signal.aborted)
        void subscription.close().catch(() => undefined);
    };
  });
  return {
    kind: "desktop" as const,
    descriptor,
    signal: wire.signal,
    keyring: background.keyring,
    chain: background.chain,
    pairing: background.pairing,
    devices: background.devices,
    transport,
    forOperation,
    async isCurrent() {
      if (wire.signal.aborted) return false;
      const current = decodeDescriptor(
        await wire.request({ op: "descriptor" }),
      );
      return (
        !wire.signal.aborted &&
        current.generation === descriptor.generation &&
        current.accountId === descriptor.accountId &&
        current.serviceOrigin === descriptor.serviceOrigin &&
        current.serviceDeviceId === descriptor.serviceDeviceId &&
        current.syncPrincipalId === descriptor.syncPrincipalId &&
        current.publicKeys.signing === descriptor.publicKeys.signing &&
        current.publicKeys.sealing === descriptor.publicKeys.sealing
      );
    },
  };
}
