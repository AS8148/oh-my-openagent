# Windows root-shard diagnostics (#10814)

Both Windows root shards collect the same measurements. The serial quarantine
stays serial; the rpc-host and remainder invocations keep their existing
partition, isolation, crash-wrapper policy and timeout budgets.

After this workflow is available on a dispatchable ref, run both legs against
the **same full commit SHA containing these diagnostics**:

```sh
gh workflow run ci.yml --repo code-yeongyu/oh-my-openagent --ref <diagnostic-branch> \
  -f comparison_sha=<full-diagnostic-sha> -f windows_workers=4
gh workflow run ci.yml --repo code-yeongyu/oh-my-openagent --ref <diagnostic-branch> \
  -f comparison_sha=<full-diagnostic-sha> -f windows_workers=2
```

The test jobs check out `comparison_sha`, not a moving branch. Other CI jobs
still validate the dispatched workflow ref. Separate worker-count concurrency
groups prevent the two dispatches from cancelling each other. Push, PR and
reusable CI callers keep the default of four file workers.

Download each `windows-root-test-telemetry-<run>-<attempt>-<shard>-workers-<N>`
artifact. Per invocation it includes the existing boundary snapshot plus:

- `*-samples.jsonl`: approximately two-second host CPU utilization, available
  physical memory, test-tree RSS, descendant counts and process inventories
  (PID, parent PID, creation time, executable basename and resource counters).
  Windows process CPU time is cumulative milliseconds; macOS's dry-run probe
  reports `ps` CPU percent instead. No command lines or environments are collected.
- `*-preload.jsonl`: evaluation duration of each original preload import, in
  original order, tagged with PID and Bun worker ID. Parallel isolation still
  re-evaluates preloads for each file. These totals overlap across workers.
- `*-files.json`: Bun's native per-file wall timings. The file starts absent,
  so timing collection never feeds previous measurements into scheduling.
- `*-profile.json`: exact tested SHA, configured/observed workers, machine
  capacity, capture errors/coverage, peaks and native file timings.

The job summary includes capture coverage, peaks and the ten slowest files.
Missing/incomplete timings or sampling errors are explicitly reported. Partial
JSONL samples survive a crash; a hard job cancellation can prevent final
aggregation or artifact upload. Sampling misses short-lived/reparented children
and is not an I/O profiler. Compare distributions and repeated first-attempt
outcomes, not a single peak or green run. Existing rpc-host crash handling is
unchanged; its retry notices remain in the job log and do not count as
first-attempt evidence.

This PR is diagnostic only. The follow-up fix must demonstrate ten consecutive
completed, non-cancelled, first-attempt green Windows shard-2 runs on dev, with
all three invocations executed and no unhandled errors or unexpected temp leaks.
Diagnostic dispatches do not satisfy that acceptance streak.
