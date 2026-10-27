//! TEMPORARY measurement for omo#10762, removed after one CI run: the runner's real Disallowed CTL subject
//! algorithm, its entry count and entry lengths, and how many certificates of the real Disallowed stores each
//! candidate rule matches. Read only; prints counts, never an entry or certificate.

#[cfg(not(target_os = "windows"))]
fn main() {}

#[cfg(target_os = "windows")]
fn main() {
    use std::collections::{BTreeMap, HashSet};
    use std::ffi::CStr;
    use std::ptr::null;

    use omo_engine_trust_helper::windows::{CtlRead, System, SystemStores};
    use windows_sys::core::w;
    use windows_sys::Win32::Security::Cryptography::*;

    let CtlRead::Bytes(bytes) = System.disallowed_ctl() else {
        println!("probe ctl=absent-or-unreadable");
        return;
    };
    let encoding = X509_ASN_ENCODING | PKCS_7_ASN_ENCODING;
    let ctl = unsafe { CertCreateCTLContext(encoding, bytes.as_ptr(), bytes.len() as u32) };
    assert!(!ctl.is_null(), "CertCreateCTLContext failed");
    let info = unsafe { &*(*ctl).pCtlInfo };
    let oid = unsafe { CStr::from_ptr(info.SubjectAlgorithm.pszObjId.cast_const().cast()) }.to_string_lossy().into_owned();
    let entries = unsafe { std::slice::from_raw_parts(info.rgCTLEntry, info.cCTLEntry as usize) };
    let mut lengths = BTreeMap::new();
    let mut set = HashSet::new();
    for entry in entries {
        let id = unsafe { std::slice::from_raw_parts(entry.SubjectIdentifier.pbData, entry.SubjectIdentifier.cbData as usize) };
        *lengths.entry(id.len()).or_insert(0) += 1;
        set.insert(id.to_vec());
    }
    println!("probe ctl-oid={oid} entries={} entry-lengths={lengths:?}", entries.len());

    let (mut total, mut sha1, mut signature_hash, mut found) = (0, 0, 0, 0);
    let mut hash_lengths = BTreeMap::new();
    for (name, id) in [
        ("CURRENT_USER", CERT_SYSTEM_STORE_CURRENT_USER_ID),
        ("LOCAL_MACHINE", CERT_SYSTEM_STORE_LOCAL_MACHINE_ID),
        ("LOCAL_MACHINE_GROUP_POLICY", CERT_SYSTEM_STORE_LOCAL_MACHINE_GROUP_POLICY_ID),
        ("LOCAL_MACHINE_ENTERPRISE", CERT_SYSTEM_STORE_LOCAL_MACHINE_ENTERPRISE_ID),
    ] {
        let flags = id << CERT_SYSTEM_STORE_LOCATION_SHIFT;
        let store = unsafe {
            CertOpenStore(
                CERT_STORE_PROV_SYSTEM_W,
                0,
                0,
                flags | CERT_STORE_OPEN_EXISTING_FLAG | CERT_STORE_READONLY_FLAG,
                w!("Disallowed").cast(),
            )
        };
        if store.is_null() {
            println!("probe store={name} open-failed");
            continue;
        }
        let mut count = 0;
        let mut previous: *const CERT_CONTEXT = null();
        loop {
            let context = unsafe { CertEnumCertificatesInStore(store, previous) };
            if context.is_null() {
                break;
            }
            previous = context;
            count += 1;
            let der = unsafe { std::slice::from_raw_parts((*context).pbCertEncoded, (*context).cbCertEncoded as usize) };
            let mut thumbprint = [0u8; 20];
            let mut size = 20u32;
            let hashed = unsafe { CryptHashCertificate2(w!("SHA1"), 0, null(), der.as_ptr(), der.len() as u32, thumbprint.as_mut_ptr(), &mut size) };
            if hashed != 0 && set.contains(&thumbprint[..]) {
                sha1 += 1;
            }
            let mut digest = [0u8; 64];
            let mut size = 64u32;
            if unsafe { CryptHashToBeSigned(0, X509_ASN_ENCODING, der.as_ptr(), der.len() as u32, digest.as_mut_ptr(), &mut size) } != 0 {
                *hash_lengths.entry(size).or_insert(0) += 1;
                if set.contains(&digest[..size as usize]) {
                    signature_hash += 1;
                }
            } else {
                *hash_lengths.entry(0).or_insert(0) += 1;
            }
            if !unsafe { CertFindSubjectInCTL(encoding, CTL_CERT_SUBJECT_TYPE, context.cast(), ctl, 0) }.is_null() {
                found += 1;
            }
        }
        total += count;
        println!("probe store={name} certificates={count}");
        unsafe { CertCloseStore(store, 0) };
    }
    println!(
        "probe disallowed-certificates={total} sha1-in-ctl={sha1} signature-hash-in-ctl={signature_hash} find-subject-in-ctl={found} signature-hash-lengths={hash_lengths:?}"
    );
    unsafe { CertFreeCTLContext(ctl) };
}
