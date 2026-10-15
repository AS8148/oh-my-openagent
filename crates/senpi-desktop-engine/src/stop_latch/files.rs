//! Filesystem boundary for a monotonic, private stopped marker.
use std::{
    fs::{self, DirBuilder, File, Metadata, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::Path,
};

pub(super) const MARKER: &str = "global-stop";
const STOPPED: &[u8] = b"omo-global-stop-v1\n";

pub(super) fn validate(metadata: &Metadata, uid: u32, mode: u32) -> io::Result<()> {
    if metadata.uid() != uid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "stop state has wrong owner",
        ));
    }
    if metadata.mode() & 0o7777 != mode {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "stop state has wrong permissions",
        ));
    }
    Ok(())
}

fn create_directory(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("state directory has no parent"))?;
    create_directory(parent)?;
    match DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => File::open(parent)?.sync_all(),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

pub(super) fn directory(path: &Path, uid: u32) -> io::Result<File> {
    create_directory(path)?;
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(path)?;
    validate(&directory.metadata()?, uid, 0o700)?;
    Ok(directory)
}

pub(super) fn read(path: &Path, uid: u32) -> io::Result<bool> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path.join(MARKER))
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::other("stop marker is not a regular file"));
    }
    validate(&metadata, uid, 0o600)?;
    let mut content = Vec::new();
    file.take(64).read_to_end(&mut content)?;
    if content != STOPPED {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "malformed stop marker",
        ));
    }
    Ok(true)
}

pub(super) fn commit(path: &Path, uid: u32) -> io::Result<()> {
    let directory = directory(path, uid)?;
    let temporary = path.join(format!(".global-stop-{}.tmp", ulid::Ulid::generate()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)?;
    let committed = (|| {
        file.write_all(STOPPED)?;
        file.sync_all()?;
        fs::rename(&temporary, path.join(MARKER))?;
        directory.sync_all()
    })();
    if committed.is_err() {
        match fs::remove_file(&temporary) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => eprintln!("senpi-desktop-engine: stop temp cleanup failed: {error}"),
        }
    }
    committed
}
