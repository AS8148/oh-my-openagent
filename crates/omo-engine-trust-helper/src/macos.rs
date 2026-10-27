//! Security.framework facts (design 4.4 items 1 to 5).

use crate::document::{Chain, Document, Identity, Setting};
use objc2_core_foundation::{CFDictionary, CFRetained};
use objc2_security::SecCertificate;

/// A trust-settings value whose type the SDK does not allow; the dictionary cannot be read completely.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unreadable(pub &'static str);

pub fn collect() -> Document {
    unimplemented!("RED: macOS fact collection")
}

pub fn project_trust_settings_dictionary(
    _dictionary: &CFDictionary,
) -> Result<Setting, Unreadable> {
    unimplemented!("RED: trust-settings projection")
}

pub fn evaluate_intermediate(
    _certificate: &SecCertificate,
    _anchors: &[CFRetained<SecCertificate>],
) -> Chain {
    unimplemented!("RED: intermediate evaluation")
}

pub fn certificate_der(_certificate: &SecCertificate) -> Vec<u8> {
    unimplemented!("RED: certificate bytes")
}

pub fn identity(_der: &[u8]) -> Identity {
    unimplemented!("RED: certificate identity")
}
