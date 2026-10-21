$ErrorActionPreference = "Stop"
# Never capture command lines, executable paths, environment, or machine identity.
@(
  Get-CimInstance -ClassName Win32_Process -OperationTimeoutSec 5 |
    ForEach-Object {
      [ordered]@{
        pid = [int]$_.ProcessId
        parentPid = [int]$_.ParentProcessId
        creationTimeUtc = if ($null -eq $_.CreationDate) { $null } else { $_.CreationDate.ToUniversalTime().ToString("o") }
        name = $_.Name
        cpuTimeMs = ([double]$_.KernelModeTime + [double]$_.UserModeTime) / 10000
        rssBytes = [double]$_.WorkingSetSize
      }
    }
) | ConvertTo-Json -Depth 3 -Compress -AsArray
