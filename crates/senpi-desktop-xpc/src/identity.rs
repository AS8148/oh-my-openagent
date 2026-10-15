//! Security.framework is the only production implementation of this boundary.
pub use crate::audit::AuditToken;
use crate::{policy::evaluate, security, signing_info};
use crate::{roles::Role, RejectReason, VerifiedPeer};
use std::{ffi::c_void, marker::PhantomData, ptr::NonNull};

mod sealed {
    pub trait Sealed {}
}

pub trait PeerVerifier: sealed::Sealed {
    fn verify(&self, role: Role) -> Result<VerifiedPeer, RejectReason>;
}

/// Borrow of the actual dictionary delivered by an XPC event handler.
pub struct XpcMessage<'a> {
    pub(crate) pointer: NonNull<c_void>,
    lifetime: PhantomData<&'a c_void>,
}

impl<'a> XpcMessage<'a> {
    /// # Safety
    /// `pointer` must be a live xpc_object_t received from XPC, kept alive and
    /// unmodified throughout `'a`. A locally fabricated dictionary is not a peer.
    pub unsafe fn from_raw(pointer: NonNull<c_void>) -> Self {
        Self {
            pointer,
            lifetime: PhantomData,
        }
    }
}

enum Source<'a> {
    Message(XpcMessage<'a>),
    Audit(AuditToken),
}

/// Production verifier. It resolves and checks live code anew on every call.
pub struct SecurityVerifier<'a> {
    source: Source<'a>,
}

impl<'a> SecurityVerifier<'a> {
    pub const fn from_xpc_message(message: XpcMessage<'a>) -> Self {
        Self {
            source: Source::Message(message),
        }
    }

    /// Only for non-XPC kernel callers. Never convert a payload token into a peer.
    pub const fn from_audit_token(token: AuditToken) -> Self {
        Self {
            source: Source::Audit(token),
        }
    }

    /// The server's privileged caller allowlist contains only the controller.
    pub fn verify_privileged_client(&self) -> Result<VerifiedPeer, RejectReason> {
        self.verify(Role::NativeController)
    }

    /// Client-side reciprocal check. Engine identity is never a client role.
    pub fn verify_server(&self) -> Result<VerifiedPeer, RejectReason> {
        self.verify(Role::EngineServer)
    }
}

impl sealed::Sealed for SecurityVerifier<'_> {}

impl PeerVerifier for SecurityVerifier<'_> {
    fn verify(&self, role: Role) -> Result<VerifiedPeer, RejectReason> {
        let code = match &self.source {
            Source::Message(message) => security::message_identity(message)?,
            Source::Audit(token) => security::audit_identity(token)?,
        };
        security::check_requirement(&code, role)?;
        let info = security::signing_information(&code)?;
        evaluate(signing_info::resolve(&info)?, role)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{evaluate, tests::eligible};

    struct FakeVerifier(Result<VerifiedPeer, RejectReason>);
    impl sealed::Sealed for FakeVerifier {}
    impl PeerVerifier for FakeVerifier {
        fn verify(&self, _role: Role) -> Result<VerifiedPeer, RejectReason> {
            self.0.clone()
        }
    }

    #[test]
    fn boundary_preserves_verified_role() {
        // given
        let verifier = FakeVerifier(evaluate(
            eligible(Role::NativeController),
            Role::NativeController,
        ));
        let boundary: &dyn PeerVerifier = &verifier;
        // when
        let peer = boundary.verify(Role::NativeController).unwrap();
        // then
        assert_eq!(peer.role(), Role::NativeController);
    }

    #[test]
    fn boundary_preserves_rejection() {
        // given
        let verifier = FakeVerifier(Err(RejectReason::RequirementRejected));
        let boundary: &dyn PeerVerifier = &verifier;
        // when
        let result = boundary.verify(Role::NativeController);
        // then
        assert_eq!(result, Err(RejectReason::RequirementRejected));
    }
}
