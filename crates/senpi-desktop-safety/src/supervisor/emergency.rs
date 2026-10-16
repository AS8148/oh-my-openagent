//! A prestarted release worker never borrows the blocked session/backend.
use parking_lot::Mutex;
use senpi_desktop_core::backend::EmergencyRelease;
use std::sync::{Arc, Weak, mpsc};
use std::time::Instant;

struct Request {
    deadline: Instant,
    finished: mpsc::Sender<()>,
}

pub(super) struct EmergencyWorker {
    handles: Arc<Mutex<Vec<Weak<dyn EmergencyRelease>>>>,
    requests: mpsc::SyncSender<Request>,
}

impl EmergencyWorker {
    pub(super) fn start() -> std::io::Result<Self> {
        let handles = Arc::new(Mutex::new(Vec::<Weak<dyn EmergencyRelease>>::new()));
        let registered = Arc::clone(&handles);
        let (requests, received) = mpsc::sync_channel::<Request>(1);
        std::thread::Builder::new()
            .name("senpi-desktop-emergency-release".to_owned())
            .spawn(move || {
                while let Ok(request) = received.recv() {
                    let releases: Vec<_> =
                        registered.lock().iter().filter_map(Weak::upgrade).collect();
                    for release in releases {
                        if Instant::now() >= request.deadline {
                            break;
                        }
                        if let Err(error) = release.release_all() {
                            eprintln!("senpi-desktop: emergency input release failed: {error}");
                        }
                    }
                    if request.finished.send(()).is_err() {
                        eprintln!("senpi-desktop: emergency release outlived its deadline");
                    }
                }
            })?;
        Ok(Self { handles, requests })
    }

    pub(super) fn register(&self, release: &Arc<dyn EmergencyRelease>) {
        let mut handles = self.handles.lock();
        handles.retain(|release| release.strong_count() > 0);
        handles.push(Arc::downgrade(release));
    }

    pub(super) fn attempt(&self, deadline: Instant) {
        let (finished, received) = mpsc::channel();
        if self
            .requests
            .try_send(Request { deadline, finished })
            .is_err()
        {
            eprintln!("senpi-desktop: emergency release worker unavailable before exit");
            return;
        }
        if received
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .is_err()
        {
            eprintln!("senpi-desktop: emergency release deadline exceeded before exit");
        }
    }
}
