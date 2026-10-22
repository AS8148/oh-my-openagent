## 2026-10-22 - Preserve skill I/O errors (#10693)

Unreadable or missing skill files and configured source folders load nothing and
report their path and original I/O error. Only a resolved path outside the allowed
boundary raises SkillLinkBlockedError. Descriptor replacement still fails closed.
