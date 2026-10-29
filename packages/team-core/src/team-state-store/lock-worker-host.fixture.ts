import { parentPort, Worker, workerData } from "node:worker_threads"

const port = parentPort
if (port === null) throw new Error("worker host fixture requires a parent")
const owner = new Worker(new URL("./lock-worker.fixture.ts", import.meta.url), { workerData })
owner.on("message", (message: unknown) => {
  if (typeof message === "object" && message !== null && "event" in message) port.postMessage(message)
})
port.on("message", async (message: unknown) => {
  if (message === "hold" || message === "release") owner.postMessage(message)
  if (message === "terminate") {
    await owner.terminate()
    port.postMessage({ event: "terminated" })
  }
  if (message === "observe") {
    const { observeLockWorker } = await import("./lock-worker-lifetime")
    owner.on("message", (registration: unknown) => {
      if (typeof registration === "object" && registration !== null && "kind" in registration &&
        registration.kind === "omo-team-lock-register-v1") port.postMessage({ event: "observed" })
    })
    observeLockWorker(owner)
  }
})
