//! Native fact helper for the engine CA importer (omo#10762, design revision 12, sections 4.1, 4.4 and 6.2).
//!
//! The helper reads macOS Security.framework in its own killable process and writes one bounded JSON
//! document of facts to stdout. It makes no trust decision: `packages/omo-native/macos-trust-helper.ts`
//! decodes the document and `packages/omo-native/engine-trust-policy.ts` decides.

pub mod document;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod watchdog;

/// Collects the facts and writes them to stdout; returns the process exit code.
#[cfg(target_os = "macos")]
pub fn run() -> i32 {
    watchdog::arm(
        || std::thread::sleep(watchdog::HARD_CAP),
        // _exit: never run atexit handlers while another thread may be inside Security.framework.
        || unsafe { libc::_exit(document::EXIT_WATCHDOG) },
    );
    document::emit(&macos::collect())
}

/// The Windows helper is a later change; Linux needs no helper (design 4.3).
#[cfg(not(target_os = "macos"))]
pub fn run() -> i32 {
    document::EXIT_UNSUPPORTED
}
