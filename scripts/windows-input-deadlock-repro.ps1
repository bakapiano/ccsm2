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

    [switch]$KeepProcess
)

$ErrorActionPreference = "Stop"

$source = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class CcsmInputDeadlockProbeResult
{
    public long Posted;
    public long Sent;
    public long TimedOut;
    public bool Responsive;
    public int LastError;
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

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool IsWindow(IntPtr hWnd);

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
        long posted = 0;
        long sent = 0;
        long timedOut = 0;
        var keyDown = new IntPtr(1 | (0x1e << 16));
        var keyUp = new IntPtr(unchecked((long)(1 | (0x1e << 16) | (1U << 30) | (1U << 31))));

        var poster = new Thread(() =>
        {
            while (Volatile.Read(ref stop) == 0)
            {
                if (PostMessageW(window, WM_KEYDOWN, new UIntPtr((uint)'A'), keyDown))
                {
                    Interlocked.Increment(ref posted);
                }
                if (PostMessageW(window, WM_KEYUP, new UIntPtr((uint)'A'), keyUp))
                {
                    Interlocked.Increment(ref posted);
                }
                Thread.Sleep(0);
            }
        });

        var sender = new Thread(() =>
        {
            while (Volatile.Read(ref stop) == 0)
            {
                UIntPtr result;
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
                }
                else
                {
                    Interlocked.Increment(ref timedOut);
                }
                Thread.Sleep(0);
            }
        });

        var stopwatch = Stopwatch.StartNew();
        poster.Start();
        sender.Start();
        Thread.Sleep(TimeSpan.FromSeconds(seconds));
        Volatile.Write(ref stop, 1);
        poster.Join();
        sender.Join();
        stopwatch.Stop();

        UIntPtr probeResult;
        var responsive = SendMessageTimeoutW(
            window,
            WM_NULL,
            UIntPtr.Zero,
            IntPtr.Zero,
            SMTO_BLOCK | SMTO_ABORTIFHUNG,
            500,
            out probeResult);

        return new CcsmInputDeadlockProbeResult
        {
            Posted = posted,
            Sent = sent,
            TimedOut = timedOut,
            Responsive = responsive != IntPtr.Zero,
            LastError = Marshal.GetLastWin32Error(),
            ElapsedMilliseconds = stopwatch.ElapsedMilliseconds,
        };
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

$exePath = (Resolve-Path -LiteralPath $Executable).Path
if (-not $DataDirectory) {
    $DataDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("ccsm-input-deadlock-" + [guid]::NewGuid().ToString("N"))
}
$dataPath = [System.IO.Path]::GetFullPath($DataDirectory)
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null

$process = $null
$roundResults = @()
$passed = $false
try {
    $quotedDataPath = '"' + $dataPath + '"'
    $process = Start-Process `
        -FilePath $exePath `
        -WorkingDirectory (Split-Path -Parent $exePath) `
        -ArgumentList @("--ccsm-data-dir", $quotedDataPath) `
        -PassThru

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
            postedKeyboardMessages = $probe.Posted
            completedFocusMessages = $probe.Sent
            focusMessageTimeouts = $probe.TimedOut
            windowProbeResponsive = $probe.Responsive
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

    $passed = $roundResults.Count -eq $Rounds -and @($roundResults | Where-Object {
        $_.focusMessageTimeouts -ne 0 -or -not $_.windowProbeResponsive -or -not $_.processResponding
    }).Count -eq 0

    [pscustomobject]@{
        passed = $passed
        executable = $exePath
        productVersion = $process.MainModule.FileVersionInfo.ProductVersion
        sha256 = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant()
        dataDirectory = $dataPath
        pid = $process.Id
        windowHandle = ('0x{0:X}' -f $process.MainWindowHandle.ToInt64())
        secondsPerRound = $Seconds
        requestedRounds = $Rounds
        before = $before
        rounds = $roundResults
    } | ConvertTo-Json -Depth 6
}
finally {
    if ($process -and -not $KeepProcess) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
}

if (-not $passed) {
    exit 1
}
