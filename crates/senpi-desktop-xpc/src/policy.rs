use crate::roles::{Role, SECURITY_EPOCH, TEAM_IDENTIFIER};

pub(crate) const CS_VALID: u32 = 0x1;
pub(crate) const CS_HARD: u32 = 0x100;
pub(crate) const CS_KILL: u32 = 0x200;
pub(crate) const CS_RUNTIME: u32 = 0x10000;
pub(crate) const CS_DEBUGGED: u32 = 0x10000000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecurityOperation {
    MessageIdentity,
    AuditIdentity,
    RequirementCreation,
    SigningInformation,
    SelfAuditToken,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RejectReason {
    RequirementRejected,
    SecurityFramework {
        operation: SecurityOperation,
        status: i32,
    },
    MissingSecurityObject,
    MissingDynamicStatus,
    MalformedDynamicStatus,
    InvalidSignature,
    MissingHardening,
    Debugged,
    MalformedEntitlements,
    ForbiddenEntitlement,
    MissingSecurityEpoch,
    MalformedSecurityEpoch,
    StaleSecurityEpoch,
    WrongTeam,
    UnknownRole,
    RoleMismatch,
    MalformedSigningInformation,
}

/// Authentication eligibility only; never an approval or operation capability.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedPeer {
    role: Role,
    team: String,
    identifier: String,
    security_epoch: String,
    dynamic_status: u32,
}

impl VerifiedPeer {
    pub const fn role(&self) -> Role {
        self.role
    }
    pub fn team(&self) -> &str {
        &self.team
    }
    pub fn identifier(&self) -> &str {
        &self.identifier
    }
    pub fn security_epoch(&self) -> &str {
        &self.security_epoch
    }
    pub const fn dynamic_status(&self) -> u32 {
        self.dynamic_status
    }
}

#[derive(Clone, Debug)]
pub(crate) enum Field<T> {
    Missing,
    Malformed,
    Value(T),
}

#[derive(Clone, Debug)]
pub(crate) struct ResolvedPeer {
    pub requirement: Result<(), RejectReason>,
    pub dynamic_status: Field<u32>,
    // None means no entitlement slot. Some(empty) is a valid empty dictionary.
    pub entitlements: Result<Option<Vec<String>>, RejectReason>,
    pub security_epoch: Field<String>,
    pub team: String,
    pub identifier: String,
}

pub(crate) fn evaluate(peer: ResolvedPeer, expected: Role) -> Result<VerifiedPeer, RejectReason> {
    peer.requirement?;
    let role = match peer.identifier.as_str() {
        id if id == Role::NativeController.identifier() => Role::NativeController,
        id if id == Role::EngineServer.identifier() => Role::EngineServer,
        _ => return Err(RejectReason::UnknownRole),
    };
    if role != expected {
        return Err(RejectReason::RoleMismatch);
    }
    if peer.team != TEAM_IDENTIFIER {
        return Err(RejectReason::WrongTeam);
    }
    let status = match peer.dynamic_status {
        Field::Value(status) => status,
        Field::Missing => return Err(RejectReason::MissingDynamicStatus),
        Field::Malformed => return Err(RejectReason::MalformedDynamicStatus),
    };
    if status & CS_VALID == 0 {
        return Err(RejectReason::InvalidSignature);
    }
    if status & CS_DEBUGGED != 0 {
        return Err(RejectReason::Debugged);
    }
    let required = CS_RUNTIME | CS_HARD | CS_KILL;
    if status & required != required {
        return Err(RejectReason::MissingHardening);
    }
    if let Some(names) = peer.entitlements? {
        if names.iter().any(|name| {
            matches!(
                name.as_str(),
                "com.apple.security.cs.disable-library-validation"
                    | "com.apple.security.cs.allow-dyld-environment-variables"
                    | "com.apple.security.get-task-allow"
                    | "com.apple.security.cs.allow-jit"
                    | "com.apple.security.cs.allow-unsigned-executable-memory"
            )
        }) {
            return Err(RejectReason::ForbiddenEntitlement);
        }
    }
    let epoch = match peer.security_epoch {
        Field::Value(epoch) => epoch,
        Field::Missing => return Err(RejectReason::MissingSecurityEpoch),
        Field::Malformed => return Err(RejectReason::MalformedSecurityEpoch),
    };
    if epoch != SECURITY_EPOCH {
        return Err(RejectReason::StaleSecurityEpoch);
    }
    Ok(VerifiedPeer {
        role,
        team: peer.team,
        identifier: peer.identifier,
        security_epoch: epoch,
        dynamic_status: status,
    })
}

#[cfg(test)]
pub(crate) mod tests;
