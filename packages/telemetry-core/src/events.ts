import { createEventTelemetryClient as createInjectedEventTelemetryClient, type CreateEventTelemetryClientInput as InjectedInput } from "./injected-events"
import { createDefaultPostHogTransport } from "./posthog-transport"

export type { EventPropertyAllowlist, EventTelemetryProperties, EventTelemetrySetTimeout, EventTelemetryClient } from "./injected-events"
export type CreateEventTelemetryClientInput = Omit<InjectedInput, "transportFactory"> & { readonly transportFactory?: InjectedInput["transportFactory"] }

export function createEventTelemetryClient(input: CreateEventTelemetryClientInput) {
  return createInjectedEventTelemetryClient({ ...input, transportFactory: input.transportFactory ?? createDefaultPostHogTransport })
}
