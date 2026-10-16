//! A spawn-inherited Mach right carries an XPC endpoint, without a named
//! service or launchd job. libxpc serializes rights; copying port numbers over
//! a Unix socket would not. The child restores bootstrap before connecting.
use super::wait::Event;
use crate::{
    dictionary::Dictionary,
    native::{Endpoint, Object, Raw},
};
use std::{ffi::c_char, ptr};

// SAFETY: Mach/spawn declarations follow the SDK. Pipe ABI matches the
// exported libxpc SPI used by Chromium's sandbox/mac/xpc.h. Test-only SPI;
// production endpoint discovery remains the authenticated named listener.
unsafe extern "C" {
    static mach_task_self_: u32;
    static mut bootstrap_port: u32;
    fn mach_port_allocate(task: u32, right: u32, name: *mut u32) -> i32;
    fn mach_port_insert_right(task: u32, name: u32, poly: u32, disposition: u32) -> i32;
    fn mach_port_mod_refs(task: u32, name: u32, right: u32, delta: i32) -> i32;
    fn mach_port_deallocate(task: u32, name: u32) -> i32;
    fn task_get_special_port(task: u32, which: i32, port: *mut u32) -> i32;
    fn task_set_special_port(task: u32, which: i32, port: u32) -> i32;
    pub(super) fn posix_spawnattr_setspecialport_np(
        attr: *mut libc::posix_spawnattr_t,
        port: u32,
        which: i32,
    ) -> i32;
    fn xpc_pipe_create_from_port(port: u32, flags: i32) -> Raw;
    fn xpc_pipe_receive(port: u32, message: *mut Raw) -> i32;
    fn xpc_pipe_routine(pipe: Raw, request: Raw, reply: *mut Raw) -> i32;
    fn xpc_pipe_routine_reply(reply: Raw) -> i32;
    fn xpc_dictionary_set_mach_send(dictionary: Raw, key: *const c_char, port: u32);
    fn xpc_dictionary_copy_mach_send(dictionary: Raw, key: *const c_char) -> u32;
}

fn task() -> u32 {
    // SAFETY: initialized by libSystem before Rust main and immutable thereafter.
    unsafe { mach_task_self_ }
}

struct SendRight(u32);
impl SendRight {
    fn bootstrap() -> Self {
        let mut port = 0;
        // SAFETY: current task and a writable port result; kernel returns a send reference.
        assert_eq!(unsafe { task_get_special_port(task(), 4, &mut port) }, 0);
        Self(port)
    }
}
impl Drop for SendRight {
    fn drop(&mut self) {
        // SAFETY: this wrapper owns one send reference.
        assert_eq!(unsafe { mach_port_deallocate(task(), self.0) }, 0);
    }
}

pub(super) struct Handoff {
    pub(super) port: u32,
    ready: Event,
}
impl Handoff {
    pub(super) fn new() -> Self {
        let mut port = 0;
        // SAFETY: allocate one receive right in our own task namespace.
        assert_eq!(unsafe { mach_port_allocate(task(), 1, &mut port) }, 0);
        // SAFETY: MAKE_SEND creates a send right from the owned receive right.
        assert_eq!(unsafe { mach_port_insert_right(task(), port, port, 20) }, 0);
        let ready = Event::subscribe(port as usize, libc::EVFILT_MACHPORT, 0);
        Self { port, ready }
    }

    pub(super) fn reply(&self, endpoint: &Endpoint) {
        self.ready.wait();
        let mut raw = ptr::null_mut();
        // SAFETY: readiness established a message on our private receive right.
        assert_eq!(unsafe { xpc_pipe_receive(self.port, &mut raw) }, 0);
        // SAFETY: successful pipe receive transfers its result reference.
        let request = unsafe { Object::owned(raw) }.unwrap();
        // SAFETY: request is an actual live libxpc pipe dictionary.
        let dictionary = unsafe { Dictionary::received(request.raw()) }.unwrap();
        let mut reply = dictionary.reply().unwrap();
        reply.put_endpoint(endpoint);
        let original = SendRight::bootstrap();
        // SAFETY: live mutable reply and owned bootstrap send right; XPC retains it.
        unsafe { xpc_dictionary_set_mach_send(reply.raw(), c"bootstrap".as_ptr(), original.0) };
        // SAFETY: reply retains the actual request's send-once reply context.
        assert_eq!(unsafe { xpc_pipe_routine_reply(reply.raw()) }, 0);
    }
}
impl Drop for Handoff {
    fn drop(&mut self) {
        // SAFETY: remove our send reference before destroying our receive right.
        assert_eq!(unsafe { mach_port_deallocate(task(), self.port) }, 0);
        // SAFETY: exactly one owned receive reference, with no further users here.
        assert_eq!(unsafe { mach_port_mod_refs(task(), self.port, 1, -1) }, 0);
    }
}

pub(super) fn receive() -> Endpoint {
    let inherited = SendRight::bootstrap();
    // SAFETY: the inherited special port is a valid send right to the parent.
    let pipe = unsafe { Object::owned(xpc_pipe_create_from_port(inherited.0, 0)) }.unwrap();
    let request = Dictionary::new().unwrap();
    let mut raw = ptr::null_mut();
    // SAFETY: live pipe/request and writable result pointer.
    assert_eq!(
        unsafe { xpc_pipe_routine(pipe.raw(), request.raw(), &mut raw) },
        0
    );
    // SAFETY: successful routine transfers a reply reference.
    let reply = unsafe { Object::owned(raw) }.unwrap();
    // SAFETY: reply is the received live pipe dictionary.
    let dictionary = unsafe { Dictionary::received(reply.raw()) }.unwrap();
    // SAFETY: dictionary owns the serialized parent's original bootstrap right.
    let original =
        unsafe { xpc_dictionary_copy_mach_send(dictionary.raw(), c"bootstrap".as_ptr()) };
    assert_ne!(original, 0);
    // SAFETY: restore this child's kernel bootstrap before creating connections.
    assert_eq!(unsafe { task_set_special_port(task(), 4, original) }, 0);
    // SAFETY: only this exact fixture runs in the child. Restore its libSystem
    // bootstrap variable during handoff, before client/runtime service use.
    unsafe { bootstrap_port = original };
    dictionary.test_endpoint().unwrap()
}
