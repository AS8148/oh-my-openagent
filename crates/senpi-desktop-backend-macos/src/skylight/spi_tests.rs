use std::ffi::{c_void, CStr};
use std::ptr::NonNull;

use senpi_desktop_core::error::ErrorCode;

use super::{resolve_spaces, space_spi_or_unsupported};

const SPACE_SYMBOLS: [&CStr; 9] = [
    c"SLSMainConnectionID",
    c"SLSGetActiveSpace",
    c"SLSCopySpacesForWindows",
    c"SLSMoveWindowsToManagedSpace",
    c"SLSGetWindowOwner",
    c"SLSConnectionGetPID",
    c"SLSSpaceGetType",
    c"SLSCopyManagedDisplays",
    c"SLSManagedDisplayGetCurrentSpace",
];

/// Stands in for every resolved address; resolution only stores it.
static RESOLVED: u8 = 0;

fn resolved() -> NonNull<c_void> {
    NonNull::from(&RESOLVED).cast()
}

#[test]
fn every_space_symbol_resolved_yields_the_set() {
    // Given / When
    let spi = resolve_spaces(|_| Some(resolved()));
    // Then
    assert!(spi.is_some());
}

#[test]
fn any_missing_space_symbol_is_space_unsupported() {
    for missing in SPACE_SYMBOLS {
        // Given: this macOS does not export `missing` (nor its CGS alias)
        let lookup = |name: &CStr| {
            let alias = name == c"CGSMainConnectionID" && missing == c"SLSMainConnectionID"
                || name == c"CGSGetActiveSpace" && missing == c"SLSGetActiveSpace";
            (name != missing && !alias).then(resolved)
        };
        // When
        let spi = resolve_spaces(lookup);
        // Then: no partial set, and the caller is told SpaceUnsupported
        assert!(spi.is_none(), "{missing:?}");
        let error = space_spi_or_unsupported(spi.as_ref()).map(|_| ()).expect_err("unsupported");
        assert_eq!(error.code, ErrorCode::SpaceUnsupported, "{missing:?}");
    }
}

#[test]
fn the_coregraphics_connection_aliases_stand_in_for_skylights() {
    // Given: only the CGS names of the connection and active-Space functions
    let lookup = |name: &CStr| (name != c"SLSMainConnectionID" && name != c"SLSGetActiveSpace").then(resolved);
    // When / Then
    assert!(resolve_spaces(lookup).is_some());
}
