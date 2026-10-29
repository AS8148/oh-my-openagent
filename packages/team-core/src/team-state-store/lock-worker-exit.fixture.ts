import { workerData } from "node:worker_threads"
import { z } from "zod"
import { publishLockRecord } from "./lock-publish"
import { buildLockRecord } from "./lock-record"

const lockPath = z.string().parse(workerData)
await publishLockRecord(lockPath, await buildLockRecord("natural-exit"))
