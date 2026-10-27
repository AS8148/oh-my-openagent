### Fixed

- Native telemetry's OTLP projection maps a model id outside the collector's pinned vocabulary to `custom`.
  Before, an unlisted id such as `claude-fable-5-5` was passed through unchanged, and the collector rejected
  the whole record (`invalid_enum`). This covers `omo.model_id` and every other model field the pin
  restricts. (#PRNUM)

<!-- changes-log: packages/omo-senpi/changes.md -->
## 2026-10-27 - OTLP model ids fall back to custom (#PRNUM)

The projection keeps the pin's model enum (omo-telemetry 13c6e61b, 44 values) and the 15 wire keys that use
it. An unlisted value is sent as `custom`, which the pin lists, so the collector no longer drops a turn when
the client vocabulary is ahead of the pin. Update the list together with the pin.
