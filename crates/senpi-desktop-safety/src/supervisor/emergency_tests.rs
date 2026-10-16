use super::*;
use crate::FakeClock;
use senpi_desktop_backend_fake::{FakeBackend, FakeScenario, SinkOp};
use senpi_desktop_core::{
    backend::{Backend, DeliveryMode},
    holds::HoldControl,
    keys::parse_key,
    types::Target,
};
use std::sync::{Barrier, mpsc};
use std::time::Duration;

#[test]
fn r3_emergency_key_up_precedes_exit_while_other_scope_is_stuck_in_prep() {
    // given: two real scopes, neither can unwind until test teardown.
    let committed = Arc::new(AtomicBool::new(false));
    let stored = Arc::clone(&committed);
    let mut supervisor =
        Supervisor::with_stop_commit(Arc::new(FakeClock::new(0)), false, move || {
            stored.store(true, Ordering::SeqCst);
        });
    let mut backend = FakeBackend::new(FakeScenario::default());
    let sink = backend.sink();
    let events = sink.subscribe();
    let release = backend.emergency_release().unwrap();
    supervisor.register_emergency_release(&release).unwrap();
    let at_exit = Arc::new(Mutex::new(None));
    let observed = Arc::clone(&at_exit);
    supervisor.fatal_exit = Arc::new(move |code| {
        *observed.lock() = Some((
            code,
            committed.load(Ordering::SeqCst),
            sink.ops()
                .iter()
                .any(|op| matches!(op, SinkOp::HeldKey { down: false, .. })),
        ));
    });
    let supervisor = Arc::new(supervisor);
    let prep = supervisor.hold_signal();
    let held = supervisor.hold_signal();
    let prep_barrier = Arc::new(Barrier::new(2));
    let held_barrier = Arc::new(Barrier::new(2));
    let (started, ready) = mpsc::channel();
    let preparing = Arc::clone(&supervisor);
    let prep_signal = Arc::clone(&prep);
    let prep_wait = Arc::clone(&prep_barrier);
    let prep_thread = std::thread::spawn(move || {
        prep_signal.with_input(&preparing, || {
            // Foreground preparation precedes any backend down; there is nothing
            // to release for this scope, and the emergency path must not wait for it.
            started.send(()).unwrap();
            prep_wait.wait();
            Ok(())
        })
    });
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    let pressing = Arc::clone(&supervisor);
    let held_signal = Arc::clone(&held);
    let held_wait = Arc::clone(&held_barrier);
    let key_thread = std::thread::spawn(move || {
        held_signal.with_input(&pressing, || {
            backend.hold_keys(
                &Target::Desktop,
                &[parse_key("shift").unwrap()],
                DeliveryMode::Foreground,
                &HoldControl {
                    check: &|| Ok(()),
                    wait: &|| {
                        held_wait.wait();
                        Ok(())
                    },
                },
            )
        })
    });
    while !matches!(
        events.recv_timeout(Duration::from_secs(5)).unwrap(),
        SinkOp::HeldKey { down: true, .. }
    ) {}
    // when: deterministic expired release budget; generous event watchdog for
    // the fake release proves ordering independently of scheduler speed.
    supervisor.finish_stop(
        StopSource::Hotkey,
        stop::StopLimits {
            release: Some(Duration::ZERO),
            emergency: Duration::from_secs(5),
        },
    );
    let exit = *at_exit.lock();
    // Teardown before asserting also makes the RED run safe.
    prep.cancel();
    held.cancel();
    prep_barrier.wait();
    held_barrier.wait();
    assert!(prep_thread.join().unwrap().is_err());
    assert!(key_thread.join().unwrap().is_err());
    // then: a later normal cleanup cannot satisfy this captured-at-exit check.
    assert_eq!(
        exit,
        Some((1, true, true)),
        "exit preceded synthetic key-up"
    );
    assert_eq!(supervisor.stop_epoch(), 0, "fatal stop was acknowledged");
}
