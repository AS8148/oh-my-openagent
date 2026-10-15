//! Signed process fixture only. This module does not exist in a production build.
use clap::Parser;
use std::path::PathBuf;

pub(crate) fn state_dir() -> PathBuf {
    std::env::var_os("OMO_XPC_TEST_STATE_DIR")
        .map(PathBuf::from)
        .expect("the signed test harness must supply its private state directory")
}

pub(crate) async fn run_if_requested() -> bool {
    let Ok(service) = std::env::var("OMO_XPC_TEST_SERVICE") else {
        return false;
    };
    let mode = crate::cli::Cli::parse_from(["engine", "--xpc-agent", &service]).mode();
    let crate::cli::Mode::XpcAgent { name } = mode else {
        panic!("the fixture must select the real XPC agent mode");
    };
    assert!(state_dir().is_dir());
    crate::xpc::run(&name).await.expect("real XPC agent failed");
    true
}
