//! Windows native fact helper for the engine CA importer (omo#10762, design 4.1, 4.2 and 6.2).
//!
//! The helper reads Bun's bundled roots `B` from stdin as concatenated DER, collects the positive store
//! candidates, the `Disallowed` stores and the Disallowed CTL with Crypt32, verifies intermediates on an
//! exclusive-root chain engine, and writes one bounded JSON document. It makes no trust decision: the
//! launcher decodes the document (`packages/omo-native/windows-trust-facts.ts`) and the pure policy
//! (`engine-trust-policy.ts`) selects. Only `output`, `stdin` and `watchdog` are platform independent.

pub mod output;
pub mod stdin;
pub mod watchdog;
#[cfg(windows)]
pub mod win;

/// Process exit codes. A non-zero exit never writes stdout.
pub mod exit {
    pub const OK: u8 = 0;
    pub const BAD_STDIN: u8 = 65;
    pub const UNSUPPORTED_PLATFORM: u8 = 69;
    pub const INTERNAL: u8 = 70;
    pub const OVERSIZE_OUTPUT: u8 = 71;
    pub const TIMEOUT: u8 = 75;
}

/// The helper's own hard cap (design 6.2); its owner also kills it at the owner's deadline.
pub const WATCHDOG: std::time::Duration = std::time::Duration::from_secs(20);
