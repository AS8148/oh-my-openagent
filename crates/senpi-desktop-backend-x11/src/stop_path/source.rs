//! Which XI2 source devices may stop input. Only a person at a keyboard
//! stops computer use: key events from an XTEST device (`xdotool`, any
//! client's `XTestFakeKeyEvent`, the engine's own input) never count, and
//! neither do events from a device the server can no longer describe.

use std::collections::BTreeMap;

use x11rb::connection::Connection;
use x11rb::protocol::xinput::{ConnectionExt as _, DeviceType};
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _};

/// The property the X server sets on every XTEST device it creates.
const XTEST_PROPERTY: &[u8] = b"XTEST Device";

/// What the server reported for a raw event's source device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Described<'a> {
    pub kind: DeviceType,
    pub name: &'a [u8],
    /// The device carries the server's `XTEST Device` property.
    pub xtest_property: bool,
}

/// Whether a device name is the server's "<master> XTEST keyboard" slave.
/// Kept beside the property check for servers that do not set it.
pub fn named_xtest(name: &[u8]) -> bool {
    name.windows(5).any(|window| window == b"XTEST")
}

/// Whether raw events from a device count toward the chord. Fails closed: a
/// lookup that failed, or a device removed before the lookup (a client can
/// add a master, chord through its XTEST slave and remove it at once), is not
/// a physical keyboard. A real keyboard is always present when it is pressed.
pub fn physical_from(found: Option<Described<'_>>) -> bool {
    found.is_some_and(|device| {
        !device.xtest_property && !(device.kind == DeviceType::SLAVE_KEYBOARD && named_xtest(device.name))
    })
}

/// Per-connection cache of source device classifications. Device ids are
/// reused after removal, so the owner clears it on every hierarchy change.
/// Only a device the server described is cached: a failed lookup is retried
/// on the next event instead of muting that device until the next change.
#[derive(Debug, Default)]
pub struct Sources {
    known: BTreeMap<u16, bool>,
    /// The `XTEST Device` atom, `Some(None)` once the server said it has none.
    xtest_atom: Option<Option<u32>>,
}

impl Sources {
    pub fn is_physical(&mut self, conn: &impl Connection, sourceid: u16) -> bool {
        if let Some(&physical) = self.known.get(&sourceid) {
            return physical;
        }
        let atom = self.xtest_atom(conn);
        let Some(info) = conn
            .xinput_xi_query_device(sourceid)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .and_then(|reply| reply.infos.into_iter().find(|info| info.deviceid == sourceid))
        else {
            return physical_from(None);
        };
        let xtest_property = atom.is_some_and(|atom| has_property(conn, sourceid, atom));
        let physical = physical_from(Some(Described { kind: info.type_, name: &info.name, xtest_property }));
        self.known.insert(sourceid, physical);
        physical
    }

    pub fn clear(&mut self) {
        self.known.clear();
    }

    fn xtest_atom(&mut self, conn: &impl Connection) -> Option<u32> {
        if let Some(atom) = self.xtest_atom {
            return atom;
        }
        let reply = conn
            .intern_atom(true, XTEST_PROPERTY)
            .ok()
            .and_then(|cookie| cookie.reply().ok())?;
        // Cached only once the server answered, so a failed request retries.
        let atom = (reply.atom != u32::from(AtomEnum::NONE)).then_some(reply.atom);
        self.xtest_atom = Some(atom);
        atom
    }
}

/// Whether `deviceid` carries `property`. A failed request counts as
/// carrying it, so the device is not trusted as a physical keyboard.
fn has_property(conn: &impl Connection, deviceid: u16, property: u32) -> bool {
    conn.xinput_xi_get_property(deviceid, false, property, u32::from(AtomEnum::ANY), 0, 1)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .is_none_or(|reply| reply.type_ != u32::from(AtomEnum::NONE))
}
