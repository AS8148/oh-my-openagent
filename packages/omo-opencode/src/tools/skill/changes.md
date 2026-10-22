## 2026-10-22 - Surface skill I/O failures without cached fallback (#10693)

Project skill read failures, including missing native rows, remain unloaded and
surface the original error at invocation. Native rows that fail do not hide later
valid rows. Real escapes retain their containment diagnostics.
