## 2026-10-22 - Telemetry counts the providers you signed into, not only the ones you configured (#10887)

`session_started` already sent `provider_count` and `providers`, but they came from `models.json` alone: the custom providers and endpoints a user configured. Providers a user signed into, such as subscriptions or API keys stored in `auth.json`, were missing. In the last 14 days the most common `provider_count` was 0 (about 7,000 installs), and the most common `providers` was empty (about 13,100 installs).

`readOmoNativeInventory` (`packages/omo-senpi/src/components/telemetry/session-inventory.ts`) now also reads the top-level provider names in `auth.json`. It never reads a credential value, account id or key. The retired subscription names `claude-sdk-oauth` and `openai-codex` count as `anthropic-subscription` and `chatgpt-subscription`.
- `provider_count` is the number of distinct providers the user signed into or configured.
- Two new numbers on `session_started` split it: `signed_in_provider_count` and `configured_provider_count`.
- `providers` lists the shipped provider kinds, sorted. Any other provider now appears as one `custom` entry instead of being dropped, so the list agrees with the count.
- A missing `auth.json` means no sign-in. A malformed one counts no sign-ins and reports the existing `omo_native_inventory_read_failed` diagnostic, while the configured providers still count.

`docs/reference/senpi-telemetry.md` regenerates the schema block and adds the disclosure row.

