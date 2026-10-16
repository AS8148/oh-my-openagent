// Set only by the ubuntu CI step (.github/workflows/ci.yml). These rows need a /proc holder scan
// that can answer, and two host classes cannot answer it:
// - the ubuntu CI kernel: the user's own live `git` processes give EACCES on /proc/<pid>/fd;
// - a plain Linux login host such as Boat: non-dumpable same-uid daemons (systemd --user,
//   (sd-pam), pulseaudio, sshd).
// On both, the lock is kept, correctly, as possibly in use. The rows therefore run on macOS CI and
// on Boat INSIDE `unshare -Upf --mount-proc --map-current-user`, until kernel-lock liveness lands
// (omo #10322).
export const SAME_UID_GIT_UNINSPECTABLE = process.env.OMO_CI_SAME_UID_GIT_UNINSPECTABLE === "1"
