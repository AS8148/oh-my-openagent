//! D1 over the fake for mouse holds (#11459, W3): a background `holdMouse`
//! that would open a menu (a secondary button, a Control-left press, a left
//! press on a menu control) is delivered as the one press that opens it, and
//! the menu is read and closed in the same call; the hold never keeps a
//! background menu open. Other holds, and holds in the user's front app, are
//! held as before.

use senpi_desktop_backend_fake::{RecordedPointer, SinkOp};
use senpi_desktop_core::backend::{Modifiers, MouseButton};
use senpi_desktop_core::protocol_params::HoldMouseParams;

use super::worker_menu_background_tests::{fixture, menu_ops};
use crate::request::{Op, Response};
use crate::test_support::{harness, Harness};

fn hold(frame_id: &str, x: f64, y: f64, button: &str, keys: &[&str]) -> Op {
    Op::HoldMouse(HoldMouseParams {
        target: "101".to_owned(),
        x,
        y,
        duration: 0.01,
        button: Some(button.to_owned()),
        keys: Some(keys.iter().map(|key| (*key).to_owned()).collect()),
        frame_id: Some(frame_id.to_owned()),
        opts: None,
    })
}

fn pointer_ops(harness: &Harness) -> Vec<RecordedPointer> {
    harness
        .sink
        .ops()
        .into_iter()
        .filter_map(|op| match op {
            SinkOp::Pointer { event, .. } => Some(event),
            _ => None,
        })
        .collect()
}

fn held_buttons(harness: &Harness) -> usize {
    harness
        .sink
        .ops()
        .iter()
        .filter(|op| matches!(op, SinkOp::HeldButton { .. }))
        .count()
}

#[test]
fn a_background_hold_that_would_open_a_menu_is_one_press_that_lists_and_closes_it() {
    // Pixel (300, 300) is over the window body (a context menu); pixel
    // (20, 50) is global (120, 170): inside the Kind popup button.
    let kinds: [(&str, f64, f64, &str, &[&str], MouseButton, Modifiers); 3] = [
        (
            "right hold",
            300.0,
            300.0,
            "right",
            &[],
            MouseButton::Right,
            Modifiers::default(),
        ),
        (
            "ctrl-left hold",
            300.0,
            300.0,
            "left",
            &["ctrl"],
            MouseButton::Left,
            Modifiers {
                ctrl: true,
                ..Modifiers::default()
            },
        ),
        (
            "left hold on a popup button",
            20.0,
            50.0,
            "left",
            &[],
            MouseButton::Left,
            Modifiers::default(),
        ),
    ];
    for (kind, x, y, button, keys, expected_button, expected_modifiers) in kinds {
        let mut harness = harness(&fixture(false));
        let frame = harness.capture("101");
        assert_eq!(
            harness.process(hold(&frame, x, y, button, keys)),
            Ok(Response::Unit),
            "{kind}"
        );
        assert_eq!(
            menu_ops(&harness),
            [SinkOp::MenuClosed {
                window: "101".to_owned()
            }],
            "{kind}"
        );
        assert_eq!(held_buttons(&harness), 0, "{kind}: nothing stays held");
        let pressed = pointer_ops(&harness);
        assert!(
            matches!(
                pressed.as_slice(),
                [RecordedPointer::Click { count: 1, button, modifiers, .. }]
                    if *button == expected_button && *modifiers == expected_modifiers
            ),
            "{kind}: one press with the hold's button and modifiers, got {pressed:?}"
        );
    }
}

#[test]
fn holds_that_open_no_menu_are_held_as_before() {
    // A left hold on the Save button (pixel (720, 570)) opens nothing: the
    // button is pressed, held and released, and no menu is watched.
    let mut harness = harness(&fixture(false));
    let frame = harness.capture("101");
    assert_eq!(
        harness.process(hold(&frame, 720.0, 570.0, "left", &[])),
        Ok(Response::Unit)
    );
    assert!(menu_ops(&harness).is_empty());
    assert_eq!(held_buttons(&harness), 2, "a press and its release");
    assert!(pointer_ops(&harness).is_empty());
    // A right hold in the user's front app: its menu is the user's and stays.
    let mut front = crate::test_support::harness(&fixture(true));
    let frame = front.capture("101");
    assert_eq!(
        front.process(hold(&frame, 300.0, 300.0, "right", &[])),
        Ok(Response::Unit)
    );
    assert!(menu_ops(&front).is_empty());
    assert_eq!(held_buttons(&front), 2);
}
