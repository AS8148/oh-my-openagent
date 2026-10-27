//! `omo-engine-trust-helper`: stdin is Bun's bundled roots as concatenated DER, stdout is one JSON fact
//! document (see `output`). Diagnostics on stderr are sanitized codes only, never certificate contents.

use std::process::ExitCode;

use omo_engine_trust_helper::exit;

#[cfg(not(windows))]
fn main() -> ExitCode {
    eprintln!("omo-engine-trust-helper: unsupported-platform");
    ExitCode::from(exit::UNSUPPORTED_PLATFORM)
}

#[cfg(windows)]
fn main() -> ExitCode {
    use std::io::Write;

    use omo_engine_trust_helper::output::{render, RenderError, STDOUT_LIMIT};
    use omo_engine_trust_helper::stdin::{read_bounded, split_der_list, STDIN_LIMIT};
    use omo_engine_trust_helper::{watchdog, win, WATCHDOG};

    let guard = watchdog::start(WATCHDOG, || {
        eprintln!("omo-engine-trust-helper: helper-timeout");
        std::process::exit(i32::from(exit::TIMEOUT));
    });
    let fail = |code: u8, reason: &str| {
        eprintln!("omo-engine-trust-helper: {reason}");
        ExitCode::from(code)
    };
    let Ok(input) = read_bounded(&mut std::io::stdin().lock(), STDIN_LIMIT) else {
        return fail(exit::BAD_STDIN, "bad-stdin");
    };
    let Ok(bundled) = split_der_list(&input) else {
        return fail(exit::BAD_STDIN, "bad-stdin");
    };
    let output = match win::collect(&mut win::System, &bundled) {
        Ok(output) => output,
        Err(win::CollectError::BundledRoot) => return fail(exit::BAD_STDIN, "bad-stdin"),
        Err(win::CollectError::Internal) => return fail(exit::INTERNAL, "internal"),
    };
    let bytes = match render(&output, STDOUT_LIMIT) {
        Ok(bytes) => bytes,
        Err(RenderError::Oversize) => return fail(exit::OVERSIZE_OUTPUT, "oversize-output"),
        Err(RenderError::Serialize) => return fail(exit::INTERNAL, "internal"),
    };
    let mut stdout = std::io::stdout().lock();
    if stdout.write_all(&bytes).and_then(|()| stdout.flush()).is_err() {
        return fail(exit::INTERNAL, "stdout-closed");
    }
    guard.disarm();
    ExitCode::from(exit::OK)
}
