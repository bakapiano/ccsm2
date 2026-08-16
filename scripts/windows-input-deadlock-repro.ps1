[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,

    [string]$DataDirectory,

    [ValidateRange(1, 300)]
    [int]$Seconds = 15,

    [ValidateRange(1, 20)]
    [int]$Rounds = 1,

    [ValidateRange(5, 120)]
    [int]$StartupTimeoutSeconds = 30,

    [ValidateRange(1, 1000000)]
    [int]$MinimumPostedKeyboardMessages = 100,

    [ValidateRange(1, 1000000)]
    [int]$MinimumCompletedKeyboardMessages = 100,

    [ValidateRange(1, 1000000)]
    [int]$MinimumCompletedFocusMessages = 10,

    [ValidateRange(100, 10000)]
    [int]$MaximumFocusFailureStreakMilliseconds = 1000,

    [switch]$KeepProcess,

    [switch]$KeepData
)

$ErrorActionPreference = "Stop"

$source = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class CcsmInputDeadlockProbeResult
{
    public long PostAttempts;
    public long Posted;
    public long PostFailures;
    public int LastPostError;
    public long CompletedKeyboardMessages;
    public long KeyboardSendFailures;
    public long KeyboardSendTimeouts;
    public long KeyboardHungAborts;
    public long OtherKeyboardSendFailures;
    public int LastKeyboardSendError;
    public long LongestKeyboardSendFailureStreakMilliseconds;
    public long Sent;
    public long SendFailures;
    public long SendTimeouts;
    public long HungAborts;
    public long OtherSendFailures;
    public int LastSendError;
    public long LongestSendFailureStreakMilliseconds;
    public bool Responsive;
    public bool Hung;
    public int ProbeError;
    public long ElapsedMilliseconds;
}

public static class CcsmInputDeadlockProbe
{
    private const uint WM_NULL = 0x0000;
    private const uint WM_KILLFOCUS = 0x0008;
    private const uint WM_KEYDOWN = 0x0100;
    private const uint WM_KEYUP = 0x0101;
    private const uint SMTO_BLOCK = 0x0001;
    private const uint SMTO_ABORTIFHUNG = 0x0002;
    private const int ERROR_TIMEOUT = 1460;

    [DllImport("kernel32.dll")]
    private static extern void SetLastError(uint error);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsHungAppWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostMessageW(IntPtr hWnd, uint message, UIntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeoutW(
        IntPtr hWnd,
        uint message,
        UIntPtr wParam,
        IntPtr lParam,
        uint flags,
        uint timeout,
        out UIntPtr result);

    public static CcsmInputDeadlockProbeResult Run(IntPtr window, int seconds)
    {
        if (!IsWindow(window))
        {
            throw new ArgumentException("The CCSM window handle is invalid.", nameof(window));
        }

        int stop = 0;
        long postAttempts = 0;
        long posted = 0;
        long postFailures = 0;
        int lastPostError = 0;
        long completedKeyboardMessages = 0;
        long keyboardSendFailures = 0;
        long keyboardSendTimeouts = 0;
        long keyboardHungAborts = 0;
        long otherKeyboardSendFailures = 0;
        int lastKeyboardSendError = 0;
        long longestKeyboardSendFailureStreakTicks = 0;
        long sent = 0;
        long sendFailures = 0;
        long sendTimeouts = 0;
        long hungAborts = 0;
        long otherSendFailures = 0;
        int lastSendError = 0;
        long longestSendFailureStreakTicks = 0;
        var keyDown = new IntPtr(1 | (0x1e << 16));
        var keyUp = new IntPtr(unchecked((long)(1 | (0x1e << 16) | (1U << 30) | (1U << 31))));

        var poster = new Thread(() =>
        {
            while (Volatile.Read(ref stop) == 0)
            {
                Interlocked.Increment(ref postAttempts);
                SetLastError(0);
                if (PostMessageW(window, WM_KEYDOWN, new UIntPtr((uint)'A'), keyDown))
                {
                    Interlocked.Increment(ref posted);
                }
                else
                {
                    Interlocked.Increment(ref postFailures);
                    Volatile.Write(ref lastPostError, Marshal.GetLastWin32Error());
                }

                Interlocked.Increment(ref postAttempts);
                SetLastError(0);
                if (PostMessageW(window, WM_KEYUP, new UIntPtr((uint)'A'), keyUp))
                {
                    Interlocked.Increment(ref posted);
                }
                else
                {
                    Interlocked.Increment(ref postFailures);
                    Volatile.Write(ref lastPostError, Marshal.GetLastWin32Error());
                }
                Thread.Sleep(0);
            }
        });

        var sender = new Thread(() =>
        {
            long sendFailureStreakStarted = 0;
            while (Volatile.Read(ref stop) == 0)
            {
                UIntPtr result;
                SetLastError(0);
                var sendStarted = Stopwatch.GetTimestamp();
                var response = SendMessageTimeoutW(
                    window,
                    WM_KILLFOCUS,
                    UIntPtr.Zero,
                    IntPtr.Zero,
                    SMTO_BLOCK | SMTO_ABORTIFHUNG,
                    50,
                    out result);
                if (response != IntPtr.Zero)
                {
                    Interlocked.Increment(ref sent);
                    if (sendFailureStreakStarted != 0)
                    {
                        var streakTicks = Stopwatch.GetTimestamp() - sendFailureStreakStarted;
                        if (streakTicks > longestSendFailureStreakTicks)
                        {
                            longestSendFailureStreakTicks = streakTicks;
                        }
                        sendFailureStreakStarted = 0;
                    }
                }
                else
                {
                    var error = Marshal.GetLastWin32Error();
                    Interlocked.Increment(ref sendFailures);
                    Volatile.Write(ref lastSendError, error);
                    if (error == ERROR_TIMEOUT)
                    {
                        Interlocked.Increment(ref sendTimeouts);
                    }
                    else if (IsHungAppWindow(window))
                    {
                        Interlocked.Increment(ref hungAborts);
                    }
                    else
                    {
                        Interlocked.Increment(ref otherSendFailures);
                    }
                    if (sendFailureStreakStarted == 0)
                    {
                        sendFailureStreakStarted = sendStarted;
                    }
                }
                Thread.Sleep(0);
            }
            if (sendFailureStreakStarted != 0)
            {
                var streakTicks = Stopwatch.GetTimestamp() - sendFailureStreakStarted;
                if (streakTicks > longestSendFailureStreakTicks)
                {
                    longestSendFailureStreakTicks = streakTicks;
                }
            }
        });

        var keyboardSender = new Thread(() =>
        {
            long sendFailureStreakStarted = 0;
            bool sendKeyUp = false;
            while (Volatile.Read(ref stop) == 0)
            {
                UIntPtr result;
                SetLastError(0);
                var sendStarted = Stopwatch.GetTimestamp();
                var response = SendMessageTimeoutW(
                    window,
                    sendKeyUp ? WM_KEYUP : WM_KEYDOWN,
                    new UIntPtr((uint)'A'),
                    sendKeyUp ? keyUp : keyDown,
                    SMTO_BLOCK | SMTO_ABORTIFHUNG,
                    50,
                    out result);
                sendKeyUp = !sendKeyUp;
                if (response != IntPtr.Zero)
                {
                    Interlocked.Increment(ref completedKeyboardMessages);
                    if (sendFailureStreakStarted != 0)
                    {
                        var streakTicks = Stopwatch.GetTimestamp() - sendFailureStreakStarted;
                        if (streakTicks > longestKeyboardSendFailureStreakTicks)
                        {
                            longestKeyboardSendFailureStreakTicks = streakTicks;
                        }
                        sendFailureStreakStarted = 0;
                    }
                }
                else
                {
                    var error = Marshal.GetLastWin32Error();
                    Interlocked.Increment(ref keyboardSendFailures);
                    Volatile.Write(ref lastKeyboardSendError, error);
                    if (error == ERROR_TIMEOUT)
                    {
                        Interlocked.Increment(ref keyboardSendTimeouts);
                    }
                    else if (IsHungAppWindow(window))
                    {
                        Interlocked.Increment(ref keyboardHungAborts);
                    }
                    else
                    {
                        Interlocked.Increment(ref otherKeyboardSendFailures);
                    }
                    if (sendFailureStreakStarted == 0)
                    {
                        sendFailureStreakStarted = sendStarted;
                    }
                }
                Thread.Sleep(0);
            }
            if (sendFailureStreakStarted != 0)
            {
                var streakTicks = Stopwatch.GetTimestamp() - sendFailureStreakStarted;
                if (streakTicks > longestKeyboardSendFailureStreakTicks)
                {
                    longestKeyboardSendFailureStreakTicks = streakTicks;
                }
            }
        });

        var stopwatch = Stopwatch.StartNew();
        poster.Start();
        keyboardSender.Start();
        sender.Start();
        Thread.Sleep(TimeSpan.FromSeconds(seconds));
        Volatile.Write(ref stop, 1);
        poster.Join();
        keyboardSender.Join();
        sender.Join();
        stopwatch.Stop();

        UIntPtr probeResult;
        SetLastError(0);
        var responsive = SendMessageTimeoutW(
            window,
            WM_NULL,
            UIntPtr.Zero,
            IntPtr.Zero,
            SMTO_BLOCK | SMTO_ABORTIFHUNG,
            500,
            out probeResult);
        var probeError = responsive == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;

        return new CcsmInputDeadlockProbeResult
        {
            PostAttempts = postAttempts,
            Posted = posted,
            PostFailures = postFailures,
            LastPostError = lastPostError,
            CompletedKeyboardMessages = completedKeyboardMessages,
            KeyboardSendFailures = keyboardSendFailures,
            KeyboardSendTimeouts = keyboardSendTimeouts,
            KeyboardHungAborts = keyboardHungAborts,
            OtherKeyboardSendFailures = otherKeyboardSendFailures,
            LastKeyboardSendError = lastKeyboardSendError,
            LongestKeyboardSendFailureStreakMilliseconds = (long)Math.Ceiling(
                longestKeyboardSendFailureStreakTicks * 1000.0 / Stopwatch.Frequency),
            Sent = sent,
            SendFailures = sendFailures,
            SendTimeouts = sendTimeouts,
            HungAborts = hungAborts,
            OtherSendFailures = otherSendFailures,
            LastSendError = lastSendError,
            LongestSendFailureStreakMilliseconds = (long)Math.Ceiling(
                longestSendFailureStreakTicks * 1000.0 / Stopwatch.Frequency),
            Responsive = responsive != IntPtr.Zero,
            Hung = IsHungAppWindow(window),
            ProbeError = probeError,
            ElapsedMilliseconds = stopwatch.ElapsedMilliseconds,
        };
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

function Get-ProcessTreeIds {
    param([Parameter(Mandatory = $true)][int]$RootProcessId)

    $processTable = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId)
    $knownParents = [System.Collections.Generic.HashSet[uint32]]::new()
    $ownedIds = [System.Collections.Generic.HashSet[uint32]]::new()
    $null = $knownParents.Add([uint32]$RootProcessId)
    foreach ($entry in $processTable) {
        if ([uint32]$entry.ProcessId -eq [uint32]$RootProcessId) {
            $null = $ownedIds.Add([uint32]$entry.ProcessId)
            break
        }
    }

    do {
        $added = $false
        foreach ($entry in $processTable) {
            $processId = [uint32]$entry.ProcessId
            if (-not $ownedIds.Contains($processId) -and $knownParents.Contains([uint32]$entry.ParentProcessId)) {
                $null = $ownedIds.Add($processId)
                $null = $knownParents.Add($processId)
                $added = $true
            }
        }
    } while ($added)

    return @($ownedIds | Sort-Object)
}

$exePath = (Resolve-Path -LiteralPath $Executable).Path
$ownsDataDirectory = [string]::IsNullOrEmpty($DataDirectory)
if (-not $DataDirectory) {
    $DataDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("ccsm-input-deadlock-" + [guid]::NewGuid().ToString("N"))
}
$dataPath = [System.IO.Path]::GetFullPath($DataDirectory)
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null

$process = $null
$roundResults = @()
$before = $null
$stressPassed = $false
$passed = $false
$processId = $null
$windowHandle = $null
$productVersion = $null
$cleanupErrors = [System.Collections.Generic.List[string]]::new()
$processTreeCleanupRequested = $false
$processTreeTerminated = $null
$remainingProcessIds = @()
$dataDirectoryCleanupRequested = $false
$dataDirectoryRemoved = $null
$runStartedAt = [DateTimeOffset]::Now
try {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $exePath
    $startInfo.WorkingDirectory = Split-Path -Parent $exePath
    $startInfo.UseShellExecute = $false
    $startInfo.ArgumentList.Add("--ccsm-data-dir")
    $startInfo.ArgumentList.Add($dataPath)
    $process = [System.Diagnostics.Process]::Start($startInfo)
    if (-not $process) {
        throw "Failed to start CCSM"
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    $stableHandle = [IntPtr]::Zero
    $stablePolls = 0
    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 250
        $process.Refresh()
        if ($process.HasExited) {
            throw "CCSM exited during startup with code $($process.ExitCode)"
        }
        if ($process.MainWindowHandle -ne [IntPtr]::Zero -and $process.MainWindowTitle -eq "CCSM") {
            if ($process.MainWindowHandle -eq $stableHandle) {
                $stablePolls++
            }
            else {
                $stableHandle = $process.MainWindowHandle
                $stablePolls = 1
            }
            if ($stablePolls -ge 4 -and $process.Responding) {
                break
            }
        }
    }
    if ($stablePolls -lt 4) {
        throw "CCSM did not expose a stable responsive window within $StartupTimeoutSeconds seconds"
    }

    $processId = $process.Id
    $windowHandle = ('0x{0:X}' -f $process.MainWindowHandle.ToInt64())
    $productVersion = $process.MainModule.FileVersionInfo.ProductVersion

    $before = [pscustomobject]@{
        workingSetBytes = $process.WorkingSet64
        privateBytes = $process.PrivateMemorySize64
        handles = $process.HandleCount
        threads = $process.Threads.Count
    }

    for ($round = 1; $round -le $Rounds; $round++) {
        $process.Refresh()
        $probe = [CcsmInputDeadlockProbe]::Run($process.MainWindowHandle, $Seconds)
        $process.Refresh()
        $roundResults += [pscustomobject]@{
            round = $round
            durationMs = $probe.ElapsedMilliseconds
            keyboardPostAttempts = $probe.PostAttempts
            postedKeyboardMessages = $probe.Posted
            keyboardPostFailures = $probe.PostFailures
            lastKeyboardPostError = $probe.LastPostError
            completedKeyboardMessages = $probe.CompletedKeyboardMessages
            failedKeyboardMessages = $probe.KeyboardSendFailures
            keyboardMessageTimeouts = $probe.KeyboardSendTimeouts
            keyboardHungAborts = $probe.KeyboardHungAborts
            otherKeyboardSendFailures = $probe.OtherKeyboardSendFailures
            lastKeyboardSendError = $probe.LastKeyboardSendError
            longestKeyboardFailureStreakMs = $probe.LongestKeyboardSendFailureStreakMilliseconds
            completedFocusMessages = $probe.Sent
            failedFocusMessages = $probe.SendFailures
            focusMessageTimeouts = $probe.SendTimeouts
            focusHungAborts = $probe.HungAborts
            otherFocusSendFailures = $probe.OtherSendFailures
            lastFocusSendError = $probe.LastSendError
            longestFocusFailureStreakMs = $probe.LongestSendFailureStreakMilliseconds
            windowProbeResponsive = $probe.Responsive
            windowProbeError = $probe.ProbeError
            windowHung = $probe.Hung
            processResponding = $process.Responding
            workingSetBytes = $process.WorkingSet64
            privateBytes = $process.PrivateMemorySize64
            handles = $process.HandleCount
            threads = $process.Threads.Count
        }
        if (-not $probe.Responsive -or -not $process.Responding) {
            break
        }
    }

    $stressPassed = $roundResults.Count -eq $Rounds -and @($roundResults | Where-Object {
        $_.postedKeyboardMessages -lt $MinimumPostedKeyboardMessages -or
        $_.completedKeyboardMessages -lt $MinimumCompletedKeyboardMessages -or
        $_.longestKeyboardFailureStreakMs -ge $MaximumFocusFailureStreakMilliseconds -or
        $_.completedFocusMessages -lt $MinimumCompletedFocusMessages -or
        $_.longestFocusFailureStreakMs -ge $MaximumFocusFailureStreakMilliseconds -or
        -not $_.windowProbeResponsive -or
        $_.windowHung -or
        -not $_.processResponding
    }).Count -eq 0

}
finally {
    if ($process -and -not $KeepProcess) {
        $processTreeCleanupRequested = $true
        try {
            if (-not $process.HasExited) {
                $process.Kill($true)
            }
            $waitCompleted = $process.WaitForExit(10000)
            $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(10)
            do {
                $remainingProcessIds = @(Get-ProcessTreeIds -RootProcessId $process.Id)
                if ($remainingProcessIds.Count -eq 0) {
                    break
                }
                Start-Sleep -Milliseconds 100
            } while ([DateTime]::UtcNow -lt $cleanupDeadline)
            $processTreeTerminated = $waitCompleted -and $remainingProcessIds.Count -eq 0
            if (-not $processTreeTerminated) {
                $cleanupErrors.Add("CCSM process tree did not terminate within the cleanup deadline")
            }
        }
        catch {
            $processTreeTerminated = $false
            $cleanupErrors.Add("Failed to stop CCSM process tree $($process.Id): $_")
        }
    }
    if ($ownsDataDirectory -and $stressPassed -and -not $KeepProcess -and -not $KeepData) {
        $dataDirectoryCleanupRequested = $true
        try {
            $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
            $dataParent = [System.IO.Path]::GetDirectoryName($dataPath).TrimEnd('\')
            $dataLeaf = [System.IO.Path]::GetFileName($dataPath.TrimEnd('\'))
            if ($dataParent -ne $tempRoot -or $dataLeaf -notmatch '^ccsm-input-deadlock-[0-9a-f]{32}$') {
                throw "Refusing to remove unexpected data directory $dataPath"
            }
            Remove-Item -LiteralPath $dataPath -Recurse -Force -ErrorAction Stop
            $dataDirectoryRemoved = -not (Test-Path -LiteralPath $dataPath)
            if (-not $dataDirectoryRemoved) {
                $cleanupErrors.Add("Generated data directory still exists after cleanup")
            }
        }
        catch {
            $dataDirectoryRemoved = $false
            $cleanupErrors.Add("Failed to remove generated data directory: $_")
        }
    }
}

$cleanupPassed = (
    (-not $processTreeCleanupRequested -or $processTreeTerminated) -and
    (-not $dataDirectoryCleanupRequested -or $dataDirectoryRemoved) -and
    $cleanupErrors.Count -eq 0
)
$passed = $stressPassed -and $cleanupPassed

[pscustomobject]@{
    passed = $passed
    startedAt = $runStartedAt.ToString("o")
    completedAt = [DateTimeOffset]::Now.ToString("o")
    executable = $exePath
    productVersion = $productVersion
    sha256 = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant()
    dataDirectory = $dataPath
    pid = $processId
    windowHandle = $windowHandle
    secondsPerRound = $Seconds
    requestedRounds = $Rounds
    acceptance = [pscustomobject]@{
        minimumPostedKeyboardMessagesPerRound = $MinimumPostedKeyboardMessages
        minimumCompletedKeyboardMessagesPerRound = $MinimumCompletedKeyboardMessages
        minimumCompletedFocusMessagesPerRound = $MinimumCompletedFocusMessages
        maximumKeyboardFailureStreakMs = $MaximumFocusFailureStreakMilliseconds
        maximumFocusFailureStreakMs = $MaximumFocusFailureStreakMilliseconds
    }
    before = $before
    rounds = $roundResults
    cleanup = [pscustomobject]@{
        processTreeCleanupRequested = $processTreeCleanupRequested
        processTreeTerminated = $processTreeTerminated
        remainingProcessIds = $remainingProcessIds
        ownedDataDirectory = $ownsDataDirectory
        dataDirectoryCleanupRequested = $dataDirectoryCleanupRequested
        dataDirectoryRemoved = $dataDirectoryRemoved
        retainedForDiagnostics = $ownsDataDirectory -and -not $dataDirectoryCleanupRequested
        errors = @($cleanupErrors)
    }
} | ConvertTo-Json -Depth 8

if (-not $passed) {
    exit 1
}
