//! D2 measurement (omo#10762, lead ruling A): does `SecTrustEvaluateWithError` fall through to an
//! unconditional admin-domain grant when the user domain holds a grant for the same root that is scoped
//! to another host? The importer's policy (#11405) reads the scoped user grant as deciding the user
//! domain, so it does not import the root. This test only measures and reports; it asserts nothing about
//! the policy.
//!
//! It CHANGES REAL TRUST SETTINGS, so it is `#[ignore]` and runs only on the disposable macOS CI runner,
//! where the desktop-engine workflow invokes it explicitly. The root is synthetic, and every setting it
//! adds is removed again, even when a step fails.
#![cfg(target_os = "macos")]

use objc2_core_foundation::{
    CFArray, CFData, CFDictionary, CFError, CFNumber, CFRetained, CFString, CFType,
};
use objc2_security::{
    SecCertificate, SecPolicy, SecTrust, SecTrustResultType, SecTrustSettingsDomain,
};
use std::path::Path;
use std::process::Command;
use std::ptr::{self, NonNull};

const HOST: &str = "d2.omo.test";
const CONFIG: &str = "[req]
distinguished_name=dn
prompt=no
[dn]
CN=unused
[root]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
[leaf]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:d2.omo.test
";

fn openssl(dir: &Path, args: &[&str]) {
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
}

fn certificate(dir: &Path, name: &str) -> CFRetained<SecCertificate> {
    let bytes = std::fs::read(dir.join(name)).expect("issued DER");
    unsafe { SecCertificate::with_data(None, &CFData::from_bytes(&bytes)) }
        .expect("Security.framework parses the DER")
}

/// Removes every setting this test may have added, whichever step it stopped at.
struct Cleanup<'a>(&'a SecCertificate);

impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        for (domain, name) in [
            (SecTrustSettingsDomain::User, "user"),
            (SecTrustSettingsDomain::Admin, "admin"),
        ] {
            let status = unsafe { SecTrust::settings_remove_trust_settings(self.0, domain) };
            println!("D2 cleanup {name}: status {status}");
        }
    }
}

fn set(root: &SecCertificate, domain: SecTrustSettingsDomain, host_scope: Option<&str>) -> i32 {
    let policy = unsafe { SecPolicy::new_ssl(true, None) };
    let result = CFNumber::new_i32(1);
    let mut keys = vec![
        CFString::from_static_str("kSecTrustSettingsPolicy"),
        CFString::from_static_str("kSecTrustSettingsResult"),
    ];
    let scope = host_scope.map(CFString::from_str);
    let mut values: Vec<&CFType> = vec![&policy, &result];
    if let Some(scope) = &scope {
        keys.push(CFString::from_static_str("kSecTrustSettingsPolicyString"));
        values.push(scope);
    }
    let key_refs: Vec<&CFString> = keys.iter().map(|key| &**key).collect();
    let dictionary = CFDictionary::<CFString, CFType>::from_slices(&key_refs, &values);
    let array = CFArray::from_objects(&[&*dictionary]);
    unsafe { SecTrust::settings_set_trust_settings(root, domain, Some(&array)) }
}

/// System trust evaluation for the leaf at `HOST` with its root supplied, no custom anchors.
fn evaluate(leaf: &SecCertificate, root: &SecCertificate) -> (bool, u32, isize) {
    let host = CFString::from_str(HOST);
    let policy = unsafe { SecPolicy::new_ssl(true, Some(&host)) };
    let certificates = CFArray::from_objects(&[leaf, root]);
    let mut trust: *mut SecTrust = ptr::null_mut();
    let status = unsafe {
        SecTrust::create_with_certificates(&certificates, Some(&policy), NonNull::from(&mut trust))
    };
    assert_eq!(status, 0, "SecTrustCreateWithCertificates");
    let trust = unsafe { CFRetained::from_raw(NonNull::new(trust).expect("a trust object")) };
    assert_eq!(unsafe { trust.set_network_fetch_allowed(false) }, 0);
    let mut error: *mut CFError = ptr::null_mut();
    let trusted = unsafe { trust.evaluate_with_error(&mut error) };
    let code = NonNull::new(error)
        .map(|error| unsafe { CFRetained::from_raw(error) }.code())
        .unwrap_or(0);
    let mut result = SecTrustResultType::Invalid;
    unsafe { trust.trust_result(NonNull::from(&mut result)) };
    (trusted, result.0, code)
}

#[test]
#[ignore = "changes real trust settings; run only on the disposable macOS CI runner"]
fn d2_user_domain_host_scoped_grant_versus_admin_unconditional_grant() {
    let dir = tempfile::tempdir().expect("test-owned temporary directory");
    let path = dir.path();
    std::fs::write(path.join("openssl.cnf"), CONFIG).expect("config written");
    openssl(
        path,
        &[
            "ecparam",
            "-name",
            "prime256v1",
            "-genkey",
            "-noout",
            "-out",
            "root.key",
        ],
    );
    openssl(
        path,
        &[
            "req",
            "-new",
            "-x509",
            "-key",
            "root.key",
            "-config",
            "openssl.cnf",
            "-extensions",
            "root",
            "-subj",
            "/CN=omo D2 measurement root",
            "-days",
            "2",
            "-outform",
            "DER",
            "-out",
            "root.der",
        ],
    );
    openssl(
        path,
        &[
            "ecparam",
            "-name",
            "prime256v1",
            "-genkey",
            "-noout",
            "-out",
            "leaf.key",
        ],
    );
    openssl(
        path,
        &[
            "req",
            "-new",
            "-key",
            "leaf.key",
            "-config",
            "openssl.cnf",
            "-subj",
            "/CN=d2.omo.test",
            "-out",
            "leaf.csr",
        ],
    );
    openssl(
        path,
        &[
            "x509",
            "-req",
            "-in",
            "leaf.csr",
            "-CA",
            "root.der",
            "-CAform",
            "DER",
            "-CAkey",
            "root.key",
            "-set_serial",
            "2",
            "-days",
            "2",
            "-extfile",
            "openssl.cnf",
            "-extensions",
            "leaf",
            "-outform",
            "DER",
            "-out",
            "leaf.der",
        ],
    );
    let root = certificate(path, "root.der");
    let leaf = certificate(path, "leaf.der");
    let _cleanup = Cleanup(&root);

    let control = evaluate(&leaf, &root);
    println!(
        "D2 control (no settings): trusted={} result={} error={}",
        control.0, control.1, control.2
    );
    let admin = set(&root, SecTrustSettingsDomain::Admin, None);
    println!("D2 set admin unconditional TrustRoot: status {admin}");
    if admin != 0 {
        println!("D2 NOT MEASURABLE: the runner refused an admin-domain trust setting without UI (status {admin})");
        return;
    }
    let admin_only = evaluate(&leaf, &root);
    println!(
        "D2 admin grant only: trusted={} result={} error={}",
        admin_only.0, admin_only.1, admin_only.2
    );
    let user = set(&root, SecTrustSettingsDomain::User, Some("other.omo.test"));
    println!("D2 set user TrustRoot scoped to other.omo.test: status {user}");
    if user != 0 {
        println!("D2 NOT MEASURABLE: the runner refused a user-domain trust setting without UI (status {user})");
        return;
    }
    let both = evaluate(&leaf, &root);
    println!(
        "D2 admin grant + user host-scoped grant: trusted={} result={} error={}",
        both.0, both.1, both.2
    );
    let verdict = match (control.0, admin_only.0, both.0) {
        (false, true, true) => "FALLS THROUGH to the admin grant",
        (false, true, false) => "USER DOMAIN DECIDES (no fall-through)",
        _ => "INCONCLUSIVE (controls did not behave as expected)",
    };
    println!("D2 MEASURED: {verdict}");
}
