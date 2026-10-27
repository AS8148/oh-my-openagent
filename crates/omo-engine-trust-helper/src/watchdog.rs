//! The helper's own hard cap (design 6.2): when the deadline passes before the work is done, `on_expire`
//! runs on the watchdog thread. The binary passes a process exit, so a hung OS call cannot hold it.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub struct Watchdog {
    cancel: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

pub fn start(deadline: Duration, on_expire: impl FnOnce() + Send + 'static) -> Watchdog {
    let (cancel, cancelled) = mpsc::channel::<()>();
    let thread = thread::spawn(move || {
        if let Err(RecvTimeoutError::Timeout) = cancelled.recv_timeout(deadline) {
            on_expire();
        }
    });
    Watchdog { cancel: Some(cancel), thread: Some(thread) }
}

impl Watchdog {
    /// Stops the watchdog and waits for its thread, so `on_expire` can no longer run afterwards.
    pub fn disarm(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        drop(self.cancel.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    // Time is the behaviour under test here: the deadline itself is what fires.
    #[test]
    fn an_expired_deadline_runs_the_expiry_action() {
        let (fired, observed) = mpsc::channel();
        let watchdog = start(Duration::from_millis(10), move || fired.send(()).unwrap());
        assert_eq!(observed.recv_timeout(Duration::from_secs(10)), Ok(()));
        watchdog.disarm();
    }

    #[test]
    fn a_disarmed_watchdog_never_fires() {
        let fired = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&fired);
        let watchdog = start(Duration::from_secs(3600), move || flag.store(true, Ordering::SeqCst));
        watchdog.disarm();
        assert!(!fired.load(Ordering::SeqCst));
    }
}
