//! macOS peer identity foundation. Eligibility is not a user operation grant.
//!
//! Resolved policy inputs and verified-peer constructors are private. Production
//! callers obtain peers only through the sealed Security.framework verifier.
#[cfg(target_os = "macos")]
mod policy;
pub mod roles;

#[cfg(target_os = "macos")]
mod audit;
#[cfg(target_os = "macos")]
pub mod identity;
#[cfg(target_os = "macos")]
mod security;
#[cfg(target_os = "macos")]
mod signing_info;

#[cfg(target_os = "macos")]
pub use policy::{RejectReason, SecurityOperation, VerifiedPeer};
