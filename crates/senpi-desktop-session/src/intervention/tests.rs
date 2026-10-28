//! Record tests ported from oh-my-pi `control/intervention.rs` (0838d2ab44),
//! on the record's millisecond clock, plus the session's admit/check/read
//! behaviour over the fake backend's scripted user input.

use std::cell::Cell;
use std::sync::Arc;

use senpi_desktop_backend_fake::{FakeMethod, SinkOp};
use senpi_desktop_core::error::{CoreResult, ErrorCode};
use senpi_desktop_core::protocol_params::{AxSnapshotParams, CaptureParams, TypeTextParams};
use senpi_desktop_core::user_input::UserPressKind;
use serde_json::json;

use super::{check_press, Baseline, UserInputs, QUIET_MS};
use crate::request::Op;
use crate::test_support::harness;

fn record() -> Arc<UserInputs> {
    Arc::new(UserInputs::new(Box::new(|_| None)))
}

fn no_wait(_: u64) -> CoreResult<()> {
    panic!("no wait")
}

#[test]
fn the_users_input_needs_a_read_after_they_pause_in_that_app_only() {
    let inputs = record();
    // Before the session touches TextEdit, its user's input is theirs alone.
    inputs.record(7, 0);
    inputs.touch(7, Some(1), || "TextEdit".to_string());
    inputs.touch(9, Some(1), || "Notes".to_string());
    assert_eq!(inputs.state_of(7), Some((0, None)));
    inputs.record(7, 1_000);
    assert_eq!(inputs.state_of(7), Some((1, Some(1_000))));
    assert_eq!(inputs.state_of(9), Some((0, None)));
    // A read begun before the input, or under 5 s after it, does not show it.
    inputs.read(7, 0);
    inputs.read(7, 5_000);
    assert_eq!(inputs.state_of(7), Some((1, Some(1_000))));
    inputs.read(7, 6_000);
    assert_eq!(inputs.state_of(7), Some((1, None)));
    // Another app's read clears nothing here.
    inputs.record(7, 10_000);
    inputs.read(9, 20_000);
    assert_eq!(inputs.state_of(7), Some((2, Some(10_000))));
}

#[test]
fn input_waits_for_the_user_to_pause_then_fails_until_a_read() {
    let inputs = record();
    inputs.touch(7, Some(1), || "TextEdit".to_string());
    inputs.record(7, 0);
    let clock = Cell::new(1_000);
    let mut waits = Vec::new();
    let error = inputs
        .admit(7, Some(60_000), || clock.get(), |ms| {
            // The user types once more while the first wait runs.
            if waits.is_empty() {
                inputs.record(7, 3_000);
            }
            waits.push(ms);
            clock.set(clock.get() + ms);
            Ok(())
        })
        .err()
        .unwrap();
    assert_eq!(error.code, ErrorCode::UserIntervened);
    assert_eq!(waits, [4_000, 3_000]);
    assert!(error.message.contains("using TextEdit (last input 5.0 s ago)"), "{}", error.message);
    assert!(error.message.contains("nothing was sent"));
    // The refusal leaves the input unread until a read after the pause.
    assert_eq!(inputs.state_of(7), Some((2, Some(3_000))));
    assert!(inputs.admit(7, None, || 9_000, no_wait).is_err());
    inputs.read(7, 9_000);
    assert_eq!(inputs.admit(7, None, || 9_000, no_wait).unwrap(), Baseline(2));
}

#[test]
fn the_runs_deadline_ends_the_wait_for_a_user_still_typing() {
    let inputs = record();
    inputs.touch(7, Some(1), || "TextEdit".to_string());
    inputs.record(7, 0);
    let clock = Cell::new(1_000);
    let mut waits = Vec::new();
    let error = inputs
        .admit(7, Some(3_000), || clock.get(), |ms| {
            waits.push(ms);
            clock.set(clock.get() + ms);
            Ok(())
        })
        .err()
        .unwrap();
    assert_eq!(error.code, ErrorCode::UserIntervened);
    assert_eq!(waits, [1_750]);
    assert!(error.message.contains("still using TextEdit"), "{}", error.message);
}

#[test]
fn without_a_deadline_the_wait_lasts_one_quiet_period() {
    let inputs = record();
    inputs.touch(7, Some(1), || "TextEdit".to_string());
    inputs.record(7, 0);
    let clock = Cell::new(1_000);
    let error = inputs
        .admit(7, None, || clock.get(), |ms| {
            // The user keeps typing every second.
            clock.set(clock.get() + ms);
            inputs.record(7, clock.get());
            Ok(())
        })
        .err()
        .unwrap();
    assert!(error.message.contains("still using TextEdit"), "{}", error.message);
    assert_eq!(clock.get(), 1_000 + QUIET_MS);
}

#[test]
fn input_into_a_process_drawing_the_apps_panel_counts_as_input_into_the_app() {
    let inputs = Arc::new(UserInputs::new(Box::new(|_| Some(100))));
    inputs.touch(7, Some(1), || "TextEdit".to_string());
    inputs.touch(8, Some(1), || "Preview".to_string());
    let baseline = inputs.admit(7, None, || 0, no_wait).unwrap();
    // TextEdit's Save panel is drawn by process 70, which takes the input.
    inputs.route(70, 7);
    // The user clicks another app's panel, then the one the keys go to.
    inputs.record(71, 0);
    assert!(inputs.check(7, baseline).is_ok());
    inputs.record(70, 0);
    assert_eq!(inputs.check(7, baseline).unwrap_err().code, ErrorCode::UserIntervened);
    assert_eq!(inputs.state_of(8), Some((0, None)));
    // Later input waits for a read of TextEdit's window after the pause.
    assert!(inputs.admit(7, None, || 6_000, no_wait).is_err());
    inputs.read(7, 6_000);
    assert!(inputs.admit(7, None, || 6_000, no_wait).is_ok());
}

#[test]
fn a_new_process_reusing_a_watched_id_starts_unwatched() {
    let inputs = Arc::new(UserInputs::new(Box::new(|_| Some(100))));
    inputs.touch(7, Some(100), || "TextEdit".to_string());
    inputs.route(70, 7);
    // TextEdit quits; Notes starts under id 7, and the user types in it
    // before the session first reads it.
    inputs.record(7, 0);
    inputs.touch(7, Some(200), || "Notes".to_string());
    assert_eq!(inputs.state_of(7), Some((0, None)));
    assert!(inputs.admit(7, None, || 0, no_wait).is_ok());
    // The old app's panel service no longer routes into the new process.
    inputs.record(70, 0);
    assert_eq!(inputs.state_of(7), Some((0, None)));
}

#[test]
fn a_new_process_reusing_a_panels_id_takes_none_of_the_apps_input() {
    let panel_started = Arc::new(parking_lot::Mutex::new(None::<u64>));
    let started = Arc::clone(&panel_started);
    let inputs = UserInputs::new(Box::new(move |_| *started.lock()));
    inputs.touch(7, Some(1), || "TextEdit".to_string());
    // Process 70, started at 100, draws TextEdit's Save panel.
    *panel_started.lock() = Some(100);
    inputs.route(70, 7);
    inputs.record(70, 0);
    assert_eq!(inputs.state_of(7), Some((1, Some(0))));
    // It exits, and Calculator starts under id 70; the user types there.
    *panel_started.lock() = Some(200);
    inputs.record(70, 1_000);
    assert_eq!(inputs.state_of(7), Some((1, Some(0))));
    // Once the session uses Calculator, that input is Calculator's own.
    inputs.touch(70, Some(200), || "Calculator".to_string());
    inputs.record(70, 2_000);
    assert_eq!(inputs.state_of(70), Some((1, Some(2_000))));
    assert_eq!(inputs.state_of(7), Some((1, Some(0))));
}

#[test]
fn presses_the_watch_dropped_count_against_every_watched_app() {
    let inputs = record();
    inputs.touch(7, Some(1), || "TextEdit".to_string());
    inputs.touch(9, Some(1), || "Notes".to_string());
    inputs.record_unknown(4_000);
    assert_eq!(inputs.state_of(7), Some((1, Some(4_000))));
    assert_eq!(inputs.state_of(9), Some((1, Some(4_000))));
}

fn type_into(id: &str) -> Op {
    Op::TypeText(TypeTextParams { target: id.to_owned(), text: "hi".to_owned(), opts: None })
}

fn capture(id: &str) -> Op {
    Op::Capture(CaptureParams { target: id.to_owned(), caps: None, exclude_window_titles: None })
}

#[test]
fn input_into_an_app_the_user_used_since_the_last_read_is_refused_until_a_read_after_the_pause() {
    // Given: the session read window 101 (pid 4242), then the user clicked in it
    let mut harness = harness(&json!({}));
    harness.process(capture("101")).expect("captures");
    harness.user_pressed(4242, UserPressKind::Click);
    harness.pass_ms(QUIET_MS);
    // When: input aimed at that window
    let reply = harness.process(type_into("101"));
    // Then: refused without sending, audited, and the record still holds the input
    let error = reply.expect_err("refused");
    assert_eq!(error.code, ErrorCode::UserIntervened);
    assert!(error.message.contains("nothing was sent"), "{}", error.message);
    assert!(!harness.sink.ops().iter().any(|op| matches!(op, SinkOp::TypeText { .. })));
    let codes: Vec<_> = harness.audits().into_iter().map(|audit| audit.code).collect();
    assert_eq!(codes, [Some(ErrorCode::UserIntervened)]);
    // A LOOK (element inspection) clears nothing; a READ after the pause does
    harness.process(Op::AxFocused).expect("looks");
    assert_eq!(harness.process(type_into("101")).map_err(|error| error.code), Err(ErrorCode::UserIntervened));
    harness.process(Op::AxSnapshot(AxSnapshotParams { target: "101".to_owned(), opts: None })).expect("reads");
    harness.process(type_into("101")).expect("types after the read");
}

#[test]
fn a_press_during_the_input_stops_it_and_reports_what_may_have_landed() {
    // Given: the user clicks in window 101 while the keys are being sent
    let mut harness = harness(&json!({}));
    harness.process(capture("101")).expect("captures");
    let feed = harness.user_input();
    harness.faults.on_next(FakeMethod::TypeText, move || feed.press(4242, UserPressKind::Key));
    // When
    let reply = harness.process(type_into("101"));
    // Then
    let error = reply.expect_err("stopped");
    assert_eq!(error.code, ErrorCode::UserIntervened);
    assert!(error.message.contains("may already have landed"), "{}", error.message);
}

#[test]
fn input_into_another_app_and_input_before_the_session_touched_the_app_are_the_users_own() {
    // Given: the user typed in window 202 (pid 7) before the session touched it, and
    // keeps typing in a window the session never reads
    let mut harness = harness(&json!({"windows": [
        {"id": "101", "title": "a", "app": "Notes", "pid": 4242, "x": 0, "y": 0, "width": 10, "height": 10, "focused": true, "elevated": null},
        {"id": "202", "title": "b", "app": "Mail", "pid": 7, "x": 0, "y": 0, "width": 10, "height": 10, "focused": false, "elevated": null}
    ], "ax": {}}));
    harness.user_pressed(7, UserPressKind::Key);
    harness.process(capture("101")).expect("captures");
    harness.user_pressed(7, UserPressKind::Key);
    harness.pass_ms(QUIET_MS);
    // When / Then: input into 101 is not held back by input into Mail
    harness.process(type_into("101")).expect("types");
    assert!(check_press().is_ok(), "no watch stays installed after the request");
}

#[test]
fn a_cancel_while_waiting_for_the_user_to_pause_sends_nothing() {
    // Given: the user just clicked in window 101 and the caller gives up during the wait
    let mut harness = harness(&json!({}));
    harness.process(capture("101")).expect("captures");
    harness.user_pressed(4242, UserPressKind::Click);
    let calls = Cell::new(0);
    let gives_up = || {
        calls.set(calls.get() + 1);
        calls.get() > 2
    };
    // When
    let reply = harness.worker.process(type_into("101"), &gives_up);
    // Then
    assert_eq!(reply.map_err(|error| error.code), Err(ErrorCode::Cancelled));
    assert!(!harness.sink.ops().iter().any(|op| matches!(op, SinkOp::TypeText { .. })));
}

#[test]
fn a_scripted_press_during_typing_is_stamped_when_it_landed_not_when_the_next_request_asks() {
    // Given: the user clicks in window 101 right before the first key of a typeText
    let mut harness = harness(&json!({"user_presses": [{"before": "type_text", "pid": 4242}]}));
    harness.process(capture("101")).expect("captures");
    let stopped = harness.process(type_into("101")).expect_err("stopped");
    assert!(stopped.message.contains("may already have landed"), "{}", stopped.message);
    harness.pass_ms(1_000);
    // When: input one second later
    let refused = harness.process(type_into("101")).expect_err("refused");
    // Then: the record knows the press is 1 s old
    assert!(refused.message.contains("last input 1.0 s ago"), "{}", refused.message);
}

#[test]
fn without_a_feed_a_failing_window_list_does_not_fail_the_input() {
    // Given: a backend with no user-input watch, whose next window list fails
    let mut harness = harness(&json!({"user_input_feed": false}));
    harness.faults.fail_next(FakeMethod::Windows, ErrorCode::Internal);
    // When: input into a window
    let typed = harness.process(type_into("101"));
    // Then: nothing is watched, so nothing changes: the input goes through
    typed.expect("typed without listing windows");
    assert!(harness.sink.ops().iter().any(|op| matches!(op, SinkOp::TypeText { .. })), "{:?}", harness.sink.ops());
}
