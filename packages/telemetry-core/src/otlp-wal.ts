import { closeSync, mkdirSync, openSync, writeSync } from "node:fs"
import { join } from "node:path"

import { toBinary } from "@bufbuild/protobuf"

import type { LogRecordProcessor, ReadableLogRecord } from "./otel-minimal-logs"
import type { ReadableSpan, SpanProcessor } from "./otel-minimal-trace"
import { encodeLogRecord, encodeSpan } from "./otlp-encode"
import { LogRecordSchema } from "./otlp-proto/opentelemetry/proto/logs/v1/logs_pb.js"
import { SpanSchema } from "./otlp-proto/opentelemetry/proto/trace/v1/trace_pb.js"
import { activeName, batchName, deleteFile, publishBatch } from "./otlp-spool-dir"
import { frame, type Signal } from "./otlp-spool-file"

export type SpoolWriterInput = {
  readonly dir: string
  readonly signal: Signal
  readonly pid: number
  readonly bootId: string
  readonly header: Uint8Array
  readonly consent: () => boolean
  readonly onError: (error: unknown) => void
}

/**
 * This process's ACTIVE spool file for one signal. Every record is appended synchronously (no fsync)
 * BEFORE anything is queued, so a process death loses nothing already emitted. The file and the
 * directory are created on the first consented append only: telemetry that is off leaves no file.
 */
export class SpoolWriter {
  readonly #input: SpoolWriterInput
  readonly name: string
  #fd: number | null = null
  records = 0
  bytes = 0

  constructor(input: SpoolWriterInput) {
    this.#input = input
    this.name = activeName(input.signal, input.pid, input.bootId)
  }

  get signal(): Signal {
    return this.#input.signal
  }

  /** Encoding runs inside the same error boundary as the write: a record that cannot be encoded is reported, never thrown. */
  append(encode: Uint8Array | (() => Uint8Array)): boolean {
    if (!this.#input.consent()) return false
    try {
      const bytes = frame(typeof encode === "function" ? encode() : encode)
      const fd = this.#fd ?? this.#open()
      writeSync(fd, bytes)
      this.records += 1
      this.bytes += bytes.byteLength
      return true
    } catch (error) {
      this.#input.onError(error)
      return false
    }
  }

  #open(): number {
    const path = join(this.#input.dir, this.name)
    let fd: number
    try {
      fd = openSync(path, "a", 0o600)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      mkdirSync(this.#input.dir, { recursive: true, mode: 0o700 })
      fd = openSync(path, "a", 0o600)
    }
    const header = frame(this.#input.header)
    writeSync(fd, header)
    this.#fd = fd
    this.bytes = header.byteLength
    return fd
  }

  #close(): void {
    if (this.#fd === null) return
    closeSync(this.#fd)
    this.#fd = null
    this.records = 0
    this.bytes = 0
  }

  seal(batchId: string): string | null {
    if (this.#fd === null || this.records === 0) return null
    this.#close()
    const sealed = batchName(this.#input.signal, batchId)
    publishBatch(this.#input.dir, this.name, sealed)
    return sealed
  }

  discard(): void {
    const open = this.#fd !== null
    this.#close()
    if (open) deleteFile(this.#input.dir, this.name)
  }

  close(): void {
    this.#close()
  }
}

export class WalLogRecordProcessor implements LogRecordProcessor {
  readonly writer: SpoolWriter
  readonly #onAppended: (writer: SpoolWriter) => void

  constructor(writer: SpoolWriter, onAppended: (writer: SpoolWriter) => void) {
    this.writer = writer
    this.#onAppended = onAppended
  }

  onEmit(record: ReadableLogRecord): void {
    if (this.writer.append(() => toBinary(LogRecordSchema, encodeLogRecord(record)))) this.#onAppended(this.writer)
  }

  shutdown(): void {
    this.writer.close()
  }
}

export class WalSpanProcessor implements SpanProcessor {
  readonly writer: SpoolWriter
  readonly #onAppended: (writer: SpoolWriter) => void

  constructor(writer: SpoolWriter, onAppended: (writer: SpoolWriter) => void) {
    this.writer = writer
    this.#onAppended = onAppended
  }

  onEnd(span: ReadableSpan): void {
    if (this.writer.append(() => toBinary(SpanSchema, encodeSpan(span)))) this.#onAppended(this.writer)
  }

  shutdown(): void {
    this.writer.close()
  }
}
