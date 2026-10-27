//! Real Security.framework adapter tests (design 9.3). Certificates are generated per run with the OpenSSL
//! CLI in a test-owned temporary directory and exist only in memory as `SecCertificate` objects; no
//! keychain or trust store is read or written.
#![cfg(target_os = "macos")]

use objc2_core_foundation::{
    CFArray, CFData, CFDictionary, CFError, CFNumber, CFRetained, CFString, CFType,
};
use objc2_security::{SecCertificate, SecPolicy, SecTrust};
use omo_engine_trust_helper::document::{Policy, Role, Setting, SettingResult};
use omo_engine_trust_helper::macos::{
    certificate_der, evaluate_intermediate, identity, project_trust_settings_dictionary, Unreadable,
};
use std::path::Path;
use std::process::Command;
use std::ptr::{self, NonNull};

const SSL: &str = "1.2.840.113635.100.1.3";
const CONFIG: &str = "[req]
distinguished_name=dn
prompt=no
[dn]
CN=unused
[root]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
[server_intermediate]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,digitalSignature,keyCertSign,cRLSign
extendedKeyUsage=serverAuth
[client_intermediate]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,digitalSignature,keyCertSign,cRLSign
extendedKeyUsage=clientAuth
[client_leaf]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
[ca_intermediate]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,digitalSignature,keyCertSign,cRLSign
[ca_intermediate_sign_only]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
[server_intermediate_sign_only]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
extendedKeyUsage=serverAuth
[server_intermediate_any_eku]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,digitalSignature,keyCertSign,cRLSign
extendedKeyUsage=anyExtendedKeyUsage
[server_intermediate_no_ku]
basicConstraints=critical,CA:TRUE,pathlen:0
extendedKeyUsage=serverAuth
";

fn openssl(dir: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("openssl")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("the openssl CLI runs");
    assert!(
        output.status.success(),
        "openssl {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

struct Fixtures {
    dir: tempfile::TempDir,
}

impl Fixtures {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("test-owned temporary directory");
        std::fs::write(dir.path().join("openssl.cnf"), CONFIG).expect("config written");
        Fixtures { dir }
    }

    /// Issues `name` (self-signed when `issuer` is None) and returns it as an in-memory certificate.
    fn issue(
        &self,
        name: &str,
        issuer: Option<&str>,
        section: &str,
        days: u32,
    ) -> CFRetained<SecCertificate> {
        let dir = self.dir.path();
        let (key, der, csr, days) = (
            format!("{name}.key"),
            format!("{name}.der"),
            format!("{name}.csr"),
            days.to_string(),
        );
        let subject = format!("/CN=omo adapter {name}");
        openssl(
            dir,
            &[
                "ecparam",
                "-name",
                "prime256v1",
                "-genkey",
                "-noout",
                "-out",
                &key,
            ],
        );
        match issuer {
            None => openssl(
                dir,
                &[
                    "req",
                    "-new",
                    "-x509",
                    "-key",
                    &key,
                    "-config",
                    "openssl.cnf",
                    "-extensions",
                    section,
                    "-subj",
                    &subject,
                    "-days",
                    &days,
                    "-outform",
                    "DER",
                    "-out",
                    &der,
                ],
            ),
            Some(issuer) => {
                openssl(
                    dir,
                    &[
                        "req",
                        "-new",
                        "-key",
                        &key,
                        "-config",
                        "openssl.cnf",
                        "-subj",
                        &subject,
                        "-out",
                        &csr,
                    ],
                );
                let (issuer_der, issuer_key) = (format!("{issuer}.der"), format!("{issuer}.key"));
                openssl(
                    dir,
                    &[
                        "x509",
                        "-req",
                        "-in",
                        &csr,
                        "-CA",
                        &issuer_der,
                        "-CAform",
                        "DER",
                        "-CAkey",
                        &issuer_key,
                        "-set_serial",
                        "7",
                        "-days",
                        &days,
                        "-extfile",
                        "openssl.cnf",
                        "-extensions",
                        section,
                        "-outform",
                        "DER",
                        "-out",
                        &der,
                    ],
                )
            }
        };
        let bytes = std::fs::read(dir.join(&der)).expect("issued DER");
        unsafe { SecCertificate::with_data(None, &CFData::from_bytes(&bytes)) }
            .expect("Security.framework parses the DER")
    }
}

fn dictionary(entries: &[(&str, &CFType)]) -> CFRetained<CFDictionary<CFString, CFType>> {
    let keys: Vec<CFRetained<CFString>> = entries
        .iter()
        .map(|(key, _)| CFString::from_str(key))
        .collect();
    let key_refs: Vec<&CFString> = keys.iter().map(|key| &**key).collect();
    let values: Vec<&CFType> = entries.iter().map(|(_, value)| *value).collect();
    CFDictionary::from_slices(&key_refs, &values)
}

fn project(entries: &[(&str, &CFType)]) -> Result<Setting, Unreadable> {
    project_trust_settings_dictionary(dictionary(entries).as_opaque())
}

fn basic_x509_accepts(certificate: &SecCertificate, anchor: &SecCertificate) -> bool {
    let policy = unsafe { SecPolicy::new_basic_x509() };
    let mut trust: *mut SecTrust = ptr::null_mut();
    let status = unsafe {
        SecTrust::create_with_certificates(certificate, Some(&policy), NonNull::from(&mut trust))
    };
    assert_eq!(status, 0, "SecTrustCreateWithCertificates");
    let trust = unsafe { CFRetained::from_raw(NonNull::new(trust).expect("a trust object")) };
    let anchors = CFArray::from_objects(&[anchor]);
    unsafe {
        assert_eq!(trust.set_anchor_certificates(Some(anchors.as_opaque())), 0);
        assert_eq!(trust.set_anchor_certificates_only(true), 0);
        assert_eq!(trust.set_network_fetch_allowed(false), 0);
        trust.evaluate_with_error(ptr::null_mut())
    }
}

/// The production evaluation's configuration, returning the OS's own error text for a failure message.
fn ssl_failure(certificate: &SecCertificate, anchor: &SecCertificate) -> String {
    let policy = unsafe { SecPolicy::new_ssl(true, None) };
    let mut trust: *mut SecTrust = ptr::null_mut();
    let status = unsafe {
        SecTrust::create_with_certificates(certificate, Some(&policy), NonNull::from(&mut trust))
    };
    assert_eq!(status, 0, "SecTrustCreateWithCertificates");
    let trust = unsafe { CFRetained::from_raw(NonNull::new(trust).expect("a trust object")) };
    let anchors = CFArray::from_objects(&[anchor]);
    let mut error: *mut CFError = ptr::null_mut();
    let trusted = unsafe {
        assert_eq!(trust.set_anchor_certificates(Some(anchors.as_opaque())), 0);
        assert_eq!(trust.set_anchor_certificates_only(true), 0);
        assert_eq!(trust.set_network_fetch_allowed(false), 0);
        trust.evaluate_with_error(&mut error)
    };
    match NonNull::new(error).map(|error| unsafe { CFRetained::from_raw(error) }) {
        _ if trusted => "trusted".to_owned(),
        Some(error) => format!(
            "code {}: {}",
            error.code(),
            error
                .description()
                .map(|text| text.to_string())
                .unwrap_or_default()
        ),
        None => "untrusted without an error".to_owned(),
    }
}

#[test]
fn ssl_policy_rejects_client_auth_only_certificates_that_basic_x509_accepts() {
    let fixtures = Fixtures::new();
    let root = fixtures.issue("root", None, "root", 3650);
    for (name, section) in [
        ("client_intermediate", "client_intermediate"),
        ("client_leaf", "client_leaf"),
    ] {
        let certificate = fixtures.issue(name, Some("root"), section, 365);
        // The fixture discriminates: the policy the helper must never use accepts it.
        assert!(
            basic_x509_accepts(&certificate, &root),
            "{name}: BasicX509 control"
        );
        let chain = evaluate_intermediate(&certificate, std::slice::from_ref(&root));
        assert_eq!(
            chain.anchor, None,
            "{name}: the SSL server policy must reject it"
        );
        assert!(!chain.explicit_distrust, "{name}");
    }
}

#[test]
fn server_auth_intermediate_chains_to_its_custom_anchor() {
    let fixtures = Fixtures::new();
    let root = fixtures.issue("root", None, "root", 3650);
    let intermediate = fixtures.issue(
        "server_intermediate",
        Some("root"),
        "server_intermediate",
        365,
    );
    let chain = evaluate_intermediate(&intermediate, std::slice::from_ref(&root));
    let root_id = identity(&certificate_der(&root));
    assert_eq!(chain.anchor, Some(root_id.clone()));
    assert_eq!(
        chain.path,
        vec![identity(&certificate_der(&intermediate)), root_id]
    );
    assert!(!chain.explicit_distrust);
}

/// Design 4.4 item 4: Apple's checks for system-anchored server leaves (Certificate Transparency, the
/// leaf validity maximum) must not reject a CA certificate under custom anchors only. If this fails, the
/// design needs an amendment; the helper must not switch policy.
#[test]
fn custom_anchor_intermediate_is_ssl_eligible() {
    let fixtures = Fixtures::new();
    let root = fixtures.issue("root", None, "root", 3650);
    let intermediate = fixtures.issue("ca_intermediate", Some("root"), "ca_intermediate", 1825);
    let chain = evaluate_intermediate(&intermediate, std::slice::from_ref(&root));
    assert_eq!(
        chain.anchor,
        Some(identity(&certificate_der(&root))),
        "five-year intermediate without SCTs: {}",
        ssl_failure(&intermediate, &root)
    );
}

/// Measurement for the design 4.4 item 4 amendment: which property of a custom-anchored CA certificate
/// makes the SSL server policy reject it. Prints only; run explicitly with `--ignored --nocapture`.
#[test]
#[ignore = "measurement for the design amendment; prints and asserts nothing"]
fn custom_anchor_validity_and_eku_measurement() {
    let fixtures = Fixtures::new();
    let root = fixtures.issue("root", None, "root", 3650);
    for (name, section, days) in [
        ("no_eku_365", "ca_intermediate", 365),
        ("no_eku_398", "ca_intermediate", 398),
        ("no_eku_399", "ca_intermediate", 399),
        ("no_eku_825", "ca_intermediate", 825),
        ("no_eku_826", "ca_intermediate", 826),
        ("no_eku_1825", "ca_intermediate", 1825),
        ("server_eku_398", "server_intermediate", 398),
        ("server_eku_826", "server_intermediate", 826),
        ("server_eku_1825", "server_intermediate", 1825),
        ("sign_only_ku_365", "ca_intermediate_sign_only", 365),
        ("sign_only_ku_1825", "ca_intermediate_sign_only", 1825),
        ("server_eku_365", "server_intermediate", 365),
        ("server_eku_825", "server_intermediate", 825),
        (
            "server_eku_sign_only_ku_365",
            "server_intermediate_sign_only",
            365,
        ),
        ("server_eku_no_ku_365", "server_intermediate_no_ku", 365),
        ("any_eku_365", "server_intermediate_any_eku", 365),
    ] {
        let intermediate = fixtures.issue(name, Some("root"), section, days);
        println!("MEASURE {name}: {}", ssl_failure(&intermediate, &root));
    }
}

#[test]
fn an_intermediate_outside_the_anchor_set_is_not_anchored() {
    let fixtures = Fixtures::new();
    let root = fixtures.issue("root", None, "root", 3650);
    let other = fixtures.issue("other_root", None, "root", 3650);
    let intermediate = fixtures.issue(
        "server_intermediate",
        Some("root"),
        "server_intermediate",
        365,
    );
    let chain = evaluate_intermediate(&intermediate, std::slice::from_ref(&other));
    assert_eq!(chain.anchor, None);
    assert!(!chain.explicit_distrust);
    let anchored = evaluate_intermediate(&intermediate, &[other, root.clone()]);
    assert_eq!(anchored.anchor, Some(identity(&certificate_der(&root))));
}

#[test]
fn projection_reads_the_ssl_role_from_policy_properties() {
    let trust_root = CFNumber::new_i32(1);
    let server = unsafe { SecPolicy::new_ssl(true, None) };
    let client = unsafe { SecPolicy::new_ssl(false, None) };
    let host = CFString::from_static_str("example.test");
    let named = unsafe { SecPolicy::new_ssl(true, Some(&host)) };
    let basic = unsafe { SecPolicy::new_basic_x509() };
    let not_a_policy = CFString::from_static_str("not-a-policy");
    let policy_of = |policy: &CFType| {
        project(&[
            ("kSecTrustSettingsPolicy", policy),
            ("kSecTrustSettingsResult", &trust_root),
        ])
        .expect("projects")
        .policy
    };
    let ssl = |role, name_constrained| {
        Some(Policy {
            oid: Some(SSL.into()),
            role: Some(role),
            name_constrained,
        })
    };
    assert_eq!(policy_of(&server), ssl(Role::Server, false));
    assert_eq!(policy_of(&client), ssl(Role::Client, false));
    assert_eq!(policy_of(&named), ssl(Role::Server, true));
    assert_eq!(
        policy_of(&not_a_policy),
        Some(Policy {
            oid: None,
            role: Some(Role::Unknown),
            name_constrained: false
        })
    );
    let other = policy_of(&basic).expect("a policy projection");
    assert!(other
        .oid
        .as_deref()
        .is_some_and(|oid| oid != SSL && oid.split('.').all(|arc| arc.parse::<u64>().is_ok())));
    assert_eq!(other.role, None);
    assert_eq!(
        project(&[]),
        Ok(Setting {
            policy: None,
            application: false,
            policy_string: None,
            key_usage: None,
            allowed_errors: vec![],
            result: None
        })
    );
}

#[test]
fn projection_reads_every_condition_key() {
    let application = CFString::from_static_str("an application reference");
    let policy_string = CFString::from_static_str("example.test");
    let key_usage = CFNumber::new_i32(-1);
    let allowed_error = CFNumber::new_i32(-2147409654);
    let setting = project(&[
        ("kSecTrustSettingsApplication", &application),
        ("kSecTrustSettingsPolicyString", &policy_string),
        ("kSecTrustSettingsKeyUsage", &key_usage),
        ("kSecTrustSettingsAllowedError", &allowed_error),
    ])
    .expect("projects");
    assert_eq!(
        setting,
        Setting {
            policy: None,
            application: true,
            policy_string: Some("example.test".into()),
            key_usage: Some(-1),
            allowed_errors: vec![-2147409654],
            result: None,
        }
    );
    for (value, expected) in [
        (1, SettingResult::TrustRoot),
        (2, SettingResult::TrustAsRoot),
        (3, SettingResult::Deny),
        (4, SettingResult::Unspecified),
    ] {
        let number = CFNumber::new_i32(value);
        assert_eq!(
            project(&[("kSecTrustSettingsResult", &number)]).map(|setting| setting.result),
            Ok(Some(expected))
        );
    }
}

#[test]
fn projection_refuses_values_the_sdk_does_not_allow() {
    let number = CFNumber::new_i32(1);
    let text = CFString::from_static_str("1");
    let invalid = CFNumber::new_i32(0);
    let out_of_range = CFNumber::new_i32(5);
    assert_eq!(
        project(&[("kSecTrustSettingsPolicyString", &number)]),
        Err(Unreadable("kSecTrustSettingsPolicyString"))
    );
    assert_eq!(
        project(&[("kSecTrustSettingsKeyUsage", &text)]),
        Err(Unreadable("kSecTrustSettingsKeyUsage"))
    );
    assert_eq!(
        project(&[("kSecTrustSettingsAllowedError", &text)]),
        Err(Unreadable("kSecTrustSettingsAllowedError"))
    );
    let results: [&CFType; 3] = [&invalid, &out_of_range, &text];
    for result in results {
        assert_eq!(
            project(&[("kSecTrustSettingsResult", result)]),
            Err(Unreadable("kSecTrustSettingsResult"))
        );
    }
}

#[test]
fn identity_is_the_sha256_and_sha1_of_the_der() {
    let fixtures = Fixtures::new();
    let root = fixtures.issue("root", None, "root", 3650);
    let der = std::fs::read(fixtures.dir.path().join("root.der")).expect("root DER");
    assert_eq!(certificate_der(&root), der);
    let digest = |algorithm: &str| {
        let output = openssl(fixtures.dir.path(), &["dgst", algorithm, "-r", "root.der"]);
        String::from_utf8(output)
            .expect("hex digest")
            .split_whitespace()
            .next()
            .expect("a digest")
            .to_owned()
    };
    let id = identity(&der);
    assert_eq!(id.sha256, digest("-sha256"));
    assert_eq!(id.sha1, digest("-sha1"));
}
