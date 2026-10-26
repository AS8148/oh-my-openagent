import type { InputAdmission } from "./input-effects"
import type { RpcProtocolClient } from "./rpc/protocol-client"
import type { HostSessionPort } from "./rpc-host/handle-port"

/** `get_pending_inputs` answers at most this many `knownClientMessageIds` per read (senpi#3549). */
const MAX_IDS_PER_READ = 64

type Outcome = { readonly clientMessageId: string; readonly status: InputAdmission }

/**
 * The child's admission of each id, read through its daemon session. A port without the read answers
 * `undefined` (the caller keeps its same-id resend); a failed read throws, so the input stays uncertain.
 */
export async function readHostAdmissions(
  port: Pick<HostSessionPort, "getPendingInputs">,
  ids: readonly string[],
): Promise<ReadonlyMap<string, InputAdmission> | undefined> {
  if (port.getPendingInputs === undefined) return undefined
  let unsupported = false
  const admissions = await collect(ids, async batch => {
    const answer = await port.getPendingInputs?.(batch)
    if (answer === undefined) unsupported = true
    return answer?.outcomes ?? []
  })
  return unsupported ? undefined : admissions
}

/**
 * The same read over a stdio child. An error answer means this child cannot read admissions (an engine
 * before senpi#3549), which keeps the same-id resend; a lost answer throws, so the input stays uncertain.
 */
export async function readStdioAdmissions(
  client: Pick<RpcProtocolClient, "send">,
  ids: readonly string[],
): Promise<ReadonlyMap<string, InputAdmission> | undefined> {
  let unsupported = false
  const admissions = await collect(ids, async batch => {
    const response = await client.send({ type: "get_pending_inputs", knownClientMessageIds: [...batch] })
    if (!response.success || response.command !== "get_pending_inputs") {
      unsupported = true
      return []
    }
    return response.data.outcomes
  })
  return unsupported ? undefined : admissions
}

async function collect(
  ids: readonly string[],
  readBatch: (batch: readonly string[]) => Promise<readonly Outcome[]>,
): Promise<ReadonlyMap<string, InputAdmission>> {
  const admissions = new Map<string, InputAdmission>()
  for (let start = 0; start < ids.length; start += MAX_IDS_PER_READ) {
    for (const outcome of await readBatch(ids.slice(start, start + MAX_IDS_PER_READ))) {
      admissions.set(outcome.clientMessageId, outcome.status)
    }
  }
  return admissions
}
