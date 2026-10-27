//! Crypt32 facts (design 4.2): the adapter API with no behaviour yet. The adapter tests define it.

use windows_sys::Win32::Security::Cryptography::{
    CertAddEncodedCertificateToStore, CertCloseStore, CertFreeCertificateContext, CertOpenStore, CERT_CONTEXT,
    CERT_STORE_ADD_USE_EXISTING, CERT_STORE_CREATE_NEW_FLAG, CERT_STORE_PROV_MEMORY, HCERTSTORE, X509_ASN_ENCODING,
};

use crate::output::{CtlOutcome, Eku, HelperOutput, Identity, Location, SourceOutcome, SourceStore};

pub struct CertStore(HCERTSTORE);

impl CertStore {
    pub fn memory() -> Result<CertStore, u32> {
        let handle = unsafe { CertOpenStore(CERT_STORE_PROV_MEMORY, 0, 0, CERT_STORE_CREATE_NEW_FLAG, std::ptr::null()) };
        if handle.is_null() {
            return Err(0);
        }
        Ok(CertStore(handle))
    }

    pub fn add_encoded(&self, der: &[u8]) -> Option<Context> {
        let mut added: *mut CERT_CONTEXT = std::ptr::null_mut();
        let ok = unsafe {
            CertAddEncodedCertificateToStore(self.0, X509_ASN_ENCODING, der.as_ptr(), der.len() as u32, CERT_STORE_ADD_USE_EXISTING, &mut added)
        };
        (ok != 0 && !added.is_null()).then(|| Context(added))
    }
}

impl Drop for CertStore {
    fn drop(&mut self) {
        unsafe { CertCloseStore(self.0, 0) };
    }
}

pub struct Context(*const CERT_CONTEXT);

impl Context {
    pub fn as_ptr(&self) -> *const CERT_CONTEXT {
        self.0
    }

    pub fn identity(&self) -> Option<Identity> {
        None
    }
}

impl Drop for Context {
    fn drop(&mut self) {
        unsafe { CertFreeCertificateContext(self.0) };
    }
}

pub fn effective_eku(_context: &Context) -> Eku {
    Eku::Error
}

pub fn decode_disallowed_ctl(_bytes: &[u8]) -> Result<Vec<String>, CtlOutcome> {
    Err(CtlOutcome::Undecodable)
}

pub struct PhysicalRead {
    pub physical_store: Option<String>,
    pub outcome: SourceOutcome,
    pub store: Option<CertStore>,
}

pub enum CtlRead {
    Absent,
    Unreadable,
    Bytes(Vec<u8>),
}

pub trait SystemStores {
    fn read(&mut self, store: SourceStore, location: Location) -> Vec<PhysicalRead>;
    fn disallowed_ctl(&mut self) -> CtlRead;
    fn disallowed_locations(&mut self) -> Vec<Location>;
}

#[derive(Debug, PartialEq, Eq)]
pub enum CollectError {
    BundledRoot,
    Internal,
}

pub fn collect<S: SystemStores>(_stores: &mut S, _bundled: &[&[u8]]) -> Result<HelperOutput, CollectError> {
    Err(CollectError::Internal)
}

pub struct System;

impl SystemStores for System {
    fn read(&mut self, _store: SourceStore, _location: Location) -> Vec<PhysicalRead> {
        Vec::new()
    }

    fn disallowed_ctl(&mut self) -> CtlRead {
        CtlRead::Unreadable
    }

    fn disallowed_locations(&mut self) -> Vec<Location> {
        Vec::new()
    }
}
