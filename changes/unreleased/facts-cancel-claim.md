### Fixed

- Cancelled facts extraction releases its queue claim after session shutdown, allowing the next session to retry the saved input immediately instead of waiting for the 15-minute claim expiry. Claims left by a crashed process still use the existing expiry (#10813).
