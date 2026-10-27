const ERROR_CODE_SHAPE = /^[a-z][a-z0-9_]{0,47}$/

/** The typed fields of a refused response; anything off-shape is dropped here, at the wire boundary. */
export type RpcRefusalFields = { readonly errorCode?: unknown; readonly errorData?: unknown }

/** Typed error for a senpi RPC command that returned success:false. */
export class RpcCommandError extends Error {
  readonly command: string
  readonly detail: string
  readonly errorCode?: string
  readonly errorData?: object

  constructor(command: string, detail: string, refusal: RpcRefusalFields = {}) {
    super(`RPC command ${command} failed: ${detail}`)
    this.name = "RpcCommandError"
    this.command = command
    this.detail = detail
    if (typeof refusal.errorCode === "string" && ERROR_CODE_SHAPE.test(refusal.errorCode)) this.errorCode = refusal.errorCode
    if (typeof refusal.errorData === "object" && refusal.errorData !== null && !Array.isArray(refusal.errorData)) {
      this.errorData = refusal.errorData
    }
  }
}

/** The request may have reached the child; a timeout is not proof an input was refused. */
export class RpcRequestTimeout extends Error {
  constructor(readonly command: string, readonly deadlineMs: number) {
    super(`The child did not answer ${command} within ${deadlineMs} ms. Action: inspect task_output; do not resend an input until its delivery is resolved.`)
    this.name = "RpcRequestTimeout"
  }
}
