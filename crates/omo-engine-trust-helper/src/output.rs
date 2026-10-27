//! The stdout wire document. Field names and enum spellings are the decoder's contract
//! (`packages/omo-native/windows-trust-facts.ts`); the decoder rejects anything else.

use serde::Serialize;

/// Must equal `WINDOWS_TRUST_HELPER_STDOUT_LIMIT` in the decoder.
pub const STDOUT_LIMIT: usize = 16 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub sha256: String,
    pub sha1: String,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SourceStore {
    #[serde(rename = "ROOT")]
    Root,
    #[serde(rename = "CA")]
    Ca,
    TrustedPeople,
    Disallowed,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Location {
    CurrentUser,
    LocalMachine,
    CurrentUserGroupPolicy,
    LocalMachineGroupPolicy,
    LocalMachineEnterprise,
    CurrentService,
    ServiceSid,
    UserSid,
}

impl Location {
    /// The five locations Bun reads today (design 4.2 item 1).
    pub const BUN: [Location; 5] = [
        Location::CurrentUser,
        Location::LocalMachine,
        Location::CurrentUserGroupPolicy,
        Location::LocalMachineGroupPolicy,
        Location::LocalMachineEnterprise,
    ];
    /// Machine `TrustedPeople` locations; current-user `TrustedPeople` is not read, as today.
    pub const MACHINE: [Location; 3] = [
        Location::LocalMachine,
        Location::LocalMachineGroupPolicy,
        Location::LocalMachineEnterprise,
    ];
}

/// Distinct per-store outcomes (design 4.2 item 3).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SourceOutcome {
    Read,
    Absent,
    AccessDenied,
    EnumerationFailed,
    /// A physical store Windows marks open-disabled; it is not part of the system store either.
    Disabled,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CtlOutcome {
    Read,
    Absent,
    Unreadable,
    Undecodable,
    UnsupportedSubjectAlgorithm,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Eku {
    Unrestricted,
    #[serde(rename = "none")]
    NoUsage,
    Error,
    Oids { oids: Vec<String> },
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Chain {
    pub anchor: Option<Identity>,
    pub path: Vec<Identity>,
    pub explicit_distrust: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceReport {
    pub store: SourceStore,
    pub location: Location,
    pub physical_store: Option<String>,
    pub outcome: SourceOutcome,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CertificateFact {
    pub der: String,
    pub store: SourceStore,
    pub location: Location,
    pub physical_store: String,
    pub self_signed: bool,
    pub ca: bool,
    pub eku: Eku,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain: Option<Chain>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DisallowedFact {
    pub der: String,
    pub location: Location,
    pub physical_store: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HelperOutput {
    pub version: u32,
    pub os: &'static str,
    pub complete: bool,
    pub sources: Vec<SourceReport>,
    pub ctl: CtlOutcome,
    pub certificates: Vec<CertificateFact>,
    pub disallowed: Vec<DisallowedFact>,
    pub ctl_sha1: Vec<String>,
    pub bundled_roots: Vec<Identity>,
}

/// `complete` is false when any applicable negative source could not be read completely (design 4.2 item 3).
/// An absent store or value holds no entries and keeps the scan complete.
pub fn negatives_complete(sources: &[SourceReport], ctl: CtlOutcome) -> bool {
    let stores = sources.iter().all(|source| {
        source.store != SourceStore::Disallowed
            || !matches!(source.outcome, SourceOutcome::AccessDenied | SourceOutcome::EnumerationFailed)
    });
    stores && matches!(ctl, CtlOutcome::Read | CtlOutcome::Absent)
}

#[derive(Debug, PartialEq, Eq)]
pub enum RenderError {
    Oversize,
    Serialize,
}

/// The whole document or nothing: output over the bound is an error, never truncated.
pub fn render(output: &HelperOutput, limit: usize) -> Result<Vec<u8>, RenderError> {
    let bytes = serde_json::to_vec(output).map_err(|_| RenderError::Serialize)?;
    if bytes.len() > limit {
        return Err(RenderError::Oversize);
    }
    Ok(bytes)
}

pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for (index, shift) in [18u32, 12, 6, 0].into_iter().enumerate() {
            if index <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> shift) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(store: SourceStore, outcome: SourceOutcome) -> SourceReport {
        SourceReport { store, location: Location::LocalMachine, physical_store: Some(".Default".into()), outcome }
    }

    #[test]
    fn base64_matches_rfc4648_vectors() {
        let vectors = [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")];
        for (input, expected) in vectors {
            assert_eq!(base64(input.as_bytes()), expected);
        }
        assert_eq!(hex(&[0x00, 0xab, 0xff]), "00abff");
    }

    #[test]
    fn unreadable_negative_sources_make_the_scan_incomplete() {
        use SourceOutcome::*;
        for outcome in [AccessDenied, EnumerationFailed] {
            assert!(!negatives_complete(&[source(SourceStore::Disallowed, outcome)], CtlOutcome::Read));
            assert!(negatives_complete(&[source(SourceStore::Root, outcome)], CtlOutcome::Read));
        }
        for outcome in [Read, Absent, Disabled] {
            assert!(negatives_complete(&[source(SourceStore::Disallowed, outcome)], CtlOutcome::Absent));
        }
        for ctl in [CtlOutcome::Unreadable, CtlOutcome::Undecodable, CtlOutcome::UnsupportedSubjectAlgorithm] {
            assert!(!negatives_complete(&[], ctl));
        }
    }

    #[test]
    fn the_document_uses_the_decoder_spelling() {
        let document = HelperOutput {
            version: 1,
            os: "windows",
            complete: true,
            sources: vec![SourceReport {
                store: SourceStore::TrustedPeople,
                location: Location::LocalMachineGroupPolicy,
                physical_store: None,
                outcome: SourceOutcome::AccessDenied,
            }],
            ctl: CtlOutcome::UnsupportedSubjectAlgorithm,
            certificates: vec![CertificateFact {
                der: "MAA=".into(),
                store: SourceStore::Root,
                location: Location::UserSid,
                physical_store: ".Default".into(),
                self_signed: true,
                ca: false,
                eku: Eku::NoUsage,
                chain: None,
            }],
            disallowed: vec![],
            ctl_sha1: vec![],
            bundled_roots: vec![],
        };
        let value: serde_json::Value = serde_json::from_slice(&render(&document, STDOUT_LIMIT).unwrap()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "version": 1, "os": "windows", "complete": true,
                "sources": [{ "store": "TrustedPeople", "location": "LOCAL_MACHINE_GROUP_POLICY", "physicalStore": null, "outcome": "access-denied" }],
                "ctl": "unsupported-subject-algorithm",
                "certificates": [{ "der": "MAA=", "store": "ROOT", "location": "USER_SID", "physicalStore": ".Default", "selfSigned": true, "ca": false, "eku": { "kind": "none" } }],
                "disallowed": [], "ctlSha1": [], "bundledRoots": [],
            })
        );
        let oids = serde_json::to_value(Eku::Oids { oids: vec!["1.3.6.1.5.5.7.3.1".into()] }).unwrap();
        assert_eq!(oids, serde_json::json!({ "kind": "oids", "oids": ["1.3.6.1.5.5.7.3.1"] }));
        assert_eq!(serde_json::to_value(Eku::Unrestricted).unwrap(), serde_json::json!({ "kind": "unrestricted" }));
    }

    #[test]
    fn output_over_the_bound_is_refused_whole() {
        let document = HelperOutput {
            version: 1,
            os: "windows",
            complete: true,
            sources: vec![],
            ctl: CtlOutcome::Absent,
            certificates: vec![],
            disallowed: vec![],
            ctl_sha1: vec![],
            bundled_roots: vec![],
        };
        let size = render(&document, STDOUT_LIMIT).unwrap().len();
        assert_eq!(render(&document, size).map(|bytes| bytes.len()), Ok(size));
        assert_eq!(render(&document, size - 1), Err(RenderError::Oversize));
    }
}
