//! libxpc ownership and callback boundary. Raw objects never leave this crate.
use crate::{connection::TransportError, listener::prepare_listener};
use block2::{Block, RcBlock};
use std::{
    ffi::{c_char, c_void, CStr},
    ptr::{self, NonNull},
};

pub(crate) type Raw = *mut c_void;
type Handler = Block<dyn Fn(Raw)>;

// SAFETY: declarations match the macOS SDK xpc/connection.h and xpc/xpc.h ABI.
unsafe extern "C" {
    pub(crate) fn xpc_connection_create(name: *const c_char, queue: Raw) -> Raw;
    pub(crate) fn xpc_connection_create_mach_service(
        name: *const c_char,
        queue: Raw,
        flags: u64,
    ) -> Raw;
    fn xpc_connection_set_peer_code_signing_requirement(
        connection: Raw,
        requirement: *const c_char,
    ) -> i32;
    fn xpc_connection_set_event_handler(connection: Raw, handler: &Handler);
    fn xpc_connection_resume(connection: Raw);
    fn xpc_connection_cancel(connection: Raw);
    fn xpc_connection_get_euid(connection: Raw) -> libc::uid_t;
    fn xpc_connection_send_message(connection: Raw, message: Raw);
    fn xpc_endpoint_create(listener: Raw) -> Raw;
    fn xpc_retain(object: Raw) -> Raw;
    fn xpc_release(object: Raw);
    pub(crate) fn xpc_get_type(object: Raw) -> *const c_void;
    pub(crate) static _xpc_type_dictionary: u8;
    pub(crate) static _xpc_type_connection: u8;
    pub(crate) static _xpc_type_data: u8;
    pub(crate) static _xpc_type_uint64: u8;
}

pub(crate) struct Object(NonNull<c_void>);

impl Object {
    /// Caller transfers a Create-rule reference or a reference just retained.
    pub(crate) unsafe fn owned(raw: Raw) -> Result<Self, TransportError> {
        NonNull::new(raw)
            .map(Self)
            .ok_or(TransportError::Allocation)
    }

    pub(crate) fn raw(&self) -> Raw {
        self.0.as_ptr()
    }

    /// The XPC runtime guarantees this callback argument remains live.
    pub(crate) unsafe fn retained(raw: Raw) -> Result<Self, TransportError> {
        // SAFETY: caller guarantees a live XPC object during this retain.
        let raw = unsafe { xpc_retain(raw) };
        // SAFETY: the preceding retain transferred exactly one reference.
        unsafe { Self::owned(raw) }
    }
}

impl Drop for Object {
    fn drop(&mut self) {
        // SAFETY: Object owns exactly one reference, released exactly once.
        unsafe { xpc_release(self.raw()) };
    }
}

/// A live accepted/activated connection. Drop revokes only this connection.
pub(crate) struct Peer(Object);

// SAFETY: XPC connections synchronize their own state. Peer exposes only
// thread-safe send/cancel/credential APIs, never mutable dictionary access.
unsafe impl Send for Peer {}
// SAFETY: the same libxpc synchronization applies to shared Peer references.
unsafe impl Sync for Peer {}

impl Peer {
    pub(crate) fn raw(&self) -> Raw {
        self.0.raw()
    }

    pub(crate) fn same_user(&self) -> bool {
        // SAFETY: Peer owns a live connection reference.
        let uid = unsafe { xpc_connection_get_euid(self.raw()) };
        // SAFETY: geteuid has no preconditions.
        uid == unsafe { libc::geteuid() }
    }

    pub(crate) fn send(&self, dictionary: &crate::dictionary::Dictionary) {
        // SAFETY: both references remain live; XPC logically copies the dictionary.
        unsafe { xpc_connection_send_message(self.raw(), dictionary.raw()) };
    }

    pub(crate) fn cancel(&self) {
        // SAFETY: cancellation is idempotent and the retained connection is live.
        unsafe { xpc_connection_cancel(self.raw()) };
    }

    /// The listener's callback provided this inactive, runtime-owned peer.
    pub(crate) unsafe fn accept(raw: Raw) -> Result<Self, TransportError> {
        // SAFETY: the caller holds the listener event's borrowed reference.
        let object = unsafe { Object::retained(raw) }?;
        Ok(Self(object))
    }

    pub(crate) fn install(&self, callback: impl Fn(Raw) + Send + 'static) {
        let handler = RcBlock::new(callback);
        // SAFETY: the closure is 'static + Send, copied by XPC, and installed once.
        unsafe { xpc_connection_set_event_handler(self.raw(), &handler) };
        // SAFETY: this accepted peer is inactive and now has its handler.
        unsafe { xpc_connection_resume(self.raw()) };
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.cancel();
    }
}

pub(crate) struct Endpoint(Object);
// SAFETY: endpoints are immutable, retained XPC objects with atomic refcounts.
unsafe impl Send for Endpoint {}
// SAFETY: no Endpoint method mutates the object.
unsafe impl Sync for Endpoint {}

impl Endpoint {
    pub(crate) fn raw(&self) -> Raw {
        self.0.raw()
    }
    pub(crate) fn new(listener: &Listener) -> Result<Self, TransportError> {
        // SAFETY: listener is an activated listener held alive by its owner.
        let raw = unsafe { xpc_endpoint_create(listener.0.raw()) };
        // SAFETY: endpoint_create returns a Create-rule reference.
        unsafe { Object::owned(raw) }.map(Self)
    }
}

pub(crate) struct Listener(Object);

impl Listener {
    pub(crate) fn start(
        name: Option<&CStr>,
        callback: impl Fn(Raw) + Send + 'static,
    ) -> Result<Self, TransportError> {
        let raw = match name {
            Some(name) => {
                // SAFETY: NUL-terminated service name, default queue, listener flag.
                unsafe { xpc_connection_create_mach_service(name.as_ptr(), ptr::null_mut(), 1) }
            }
            None => {
                // SAFETY: NULL name and queue create an anonymous listener.
                unsafe { xpc_connection_create(ptr::null(), ptr::null_mut()) }
            }
        };
        // SAFETY: both creation APIs return one owned reference.
        let object = unsafe { Object::owned(raw) }?;
        let requirement =
            std::ffi::CString::new(crate::roles::Role::NativeController.requirement())
                .map_err(|_| TransportError::Dictionary)?;
        let handler = RcBlock::new(callback);
        let result = prepare_listener(
            || {
                // SAFETY: inactive connection and valid immutable C requirement.
                unsafe {
                    xpc_connection_set_peer_code_signing_requirement(raw, requirement.as_ptr())
                }
            },
            || {
                // SAFETY: XPC copies this 'static Send callback before activation.
                unsafe { xpc_connection_set_event_handler(raw, &handler) };
            },
            || {
                // SAFETY: requirement succeeded and handler was installed.
                unsafe { xpc_connection_resume(raw) };
            },
        );
        if let Err(error) = result {
            // SDK: releasing the last inactive Create reference is undefined.
            // Startup must terminate on this error, so leave it to process teardown.
            std::mem::forget(object);
            return Err(error);
        }
        Ok(Self(object))
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        // SAFETY: Listener is constructed only after activation; cancel before release.
        unsafe { xpc_connection_cancel(self.0.raw()) };
    }
}

pub(crate) fn is_connection(raw: Raw) -> bool {
    // SAFETY: callers pass only the live object of an XPC callback.
    unsafe { xpc_get_type(raw) == ptr::addr_of!(_xpc_type_connection).cast() }
}
