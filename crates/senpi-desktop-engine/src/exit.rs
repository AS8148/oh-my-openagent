//! macOS tap invalidation on every executable exit path that can run code.

use std::future::Future;

use tokio::signal::unix::{signal, SignalKind};

pub(super) fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic| {
        // A caught panic may hold the registry/backend lock or be on a tap
        // thread. Invalidate ports synchronously, but never join here.
        senpi_desktop_backend_macos::invalidate_input_observers();
        previous(panic);
    }));
}

pub(super) async fn run(work: impl Future<Output = Result<(), String>>) -> Result<(), String> {
    // Register before polling work, so neither signal can race tap creation.
    let mut terminate = signal(SignalKind::terminate()).map_err(|error| error.to_string())?;
    let mut interrupt = signal(SignalKind::interrupt()).map_err(|error| error.to_string())?;
    let result = tokio::select! {
        result = work => result,
        _ = terminate.recv() => Ok(()),
        _ = interrupt.recv() => Ok(()),
    };
    senpi_desktop_backend_macos::shutdown_input_observers();
    result
}
