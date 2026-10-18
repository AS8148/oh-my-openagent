//! Secure Event Input hides key events from every event tap: while it is on,
//! the tap is enabled and beating but deaf, so it must not authorize input.

use std::cell::Cell;
use std::sync::Arc;

use senpi_desktop_safety::{Chord, FakeClock, StopPathFailure, StopPathReason, StopPolicy, Supervisor};

use super::chord::{Hotkey, DEFAULT_STOP_CHORD};
use super::Shared;

const GLOBAL_ONLY: StopPolicy = StopPolicy {
    allow_host_relay_only: false,
};

thread_local! {
    /// What the injected `IsSecureEventInputEnabled` reports on this thread.
    static SECURE_INPUT: Cell<bool> = const { Cell::new(false) };
}

fn secure_input() -> bool {
    SECURE_INPUT.with(Cell::get)
}

fn set_secure_input(on: bool) {
    SECURE_INPUT.with(|secure| secure.set(on));
}

fn shared() -> Shared {
    let supervisor = Arc::new(Supervisor::new(Arc::new(FakeClock::new(1_000))));
    let hotkey = Hotkey::parse(&Chord::parse(DEFAULT_STOP_CHORD).unwrap()).unwrap();
    Shared::with_secure_input(supervisor, hotkey, secure_input).unwrap()
}

#[test]
fn secure_input_takes_the_global_path_off_until_it_ends() {
    // given: a live tap that can hear the chord
    set_secure_input(false);
    let shared = shared();
    shared.set_live(true);
    assert!(shared.supervisor.input_allowed(&GLOBAL_ONLY));

    // when: another process turns Secure Event Input on
    set_secure_input(true);
    shared.heartbeat();

    // then: input is refused with a reason the user can act on, and no stop latched
    let status = shared.supervisor.status();
    assert!(
        !shared.supervisor.input_allowed(&GLOBAL_ONLY),
        "input ran while the stop chord was deaf"
    );
    assert_eq!(
        status.stop_path_unavailable(&GLOBAL_ONLY),
        Some(StopPathReason::SecureInputActive)
    );
    assert_eq!(status.global_failure, Some(StopPathFailure::SecureInput));
    assert!(!shared.supervisor.is_suspended());
    assert!(shared.control.lock().live, "the tap itself is still up and must not be re-created");

    // when: secure input ends
    set_secure_input(false);
    shared.heartbeat();

    // then: the path authorizes input again by itself
    assert!(shared.supervisor.input_allowed(&GLOBAL_ONLY));
    assert_eq!(shared.supervisor.status().global_failure, None);
}

#[test]
fn a_tap_that_comes_up_under_secure_input_never_authorizes_input() {
    // given: secure input is already on when the tap goes live
    set_secure_input(true);
    let shared = shared();

    // when
    shared.set_live(true);

    // then
    assert!(!shared.supervisor.input_allowed(&GLOBAL_ONLY));
    assert_eq!(
        shared.supervisor.status().stop_path_unavailable(&GLOBAL_ONLY),
        Some(StopPathReason::SecureInputActive)
    );
    set_secure_input(false);
}
