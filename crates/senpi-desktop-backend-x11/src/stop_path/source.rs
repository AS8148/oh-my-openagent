//! Which XI2 source devices may stop input. Only a person at a keyboard
//! stops computer use: key events from an XTEST device (`xdotool`, any
//! client's `XTestFakeKeyEvent`, the engine's own input) never count.

use std::collections::BTreeMap;

use x11rb::connection::Connection;
use x11rb::protocol::xinput::{ConnectionExt as _, DeviceType};

/// Whether a slave device named `name` is a physical source. The X server
/// creates one "<master> XTEST keyboard" slave per master keyboard and routes
/// every XTEST event through it.
pub fn counts_as_physical(name: &[u8]) -> bool {
    !name.windows(5).any(|window| window == b"XTEST")
}

/// Per-connection cache of source device classifications. Device ids are
/// reused after removal, so the owner clears it on every hierarchy change.
#[derive(Debug, Default)]
pub struct Sources {
    known: BTreeMap<u16, bool>,
}

impl Sources {
    /// Whether raw events from `sourceid` count toward the chord. A device the
    /// server cannot describe counts: a missed stop is worse than a spurious one.
    pub fn is_physical(&mut self, conn: &impl Connection, sourceid: u16) -> bool {
        if let Some(&physical) = self.known.get(&sourceid) {
            return physical;
        }
        let physical = conn
            .xinput_xi_query_device(sourceid)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .and_then(|reply| reply.infos.into_iter().find(|info| info.deviceid == sourceid))
            .is_none_or(|info| info.type_ != DeviceType::SLAVE_KEYBOARD || counts_as_physical(&info.name));
        self.known.insert(sourceid, physical);
        physical
    }

    pub fn clear(&mut self) {
        self.known.clear();
    }
}
