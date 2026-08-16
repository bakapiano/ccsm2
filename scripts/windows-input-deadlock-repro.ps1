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

    [ValidateRange(0, 100)]
    [int]$MaximumKeyboardPostFailurePercent = 10,

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
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class CcsmProcessJob : IDisposable
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const int JobObjectBasicProcessIdList = 3;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int ERROR_MORE_DATA = 234;
    private const int MaximumTrackedProcesses = 4096;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    private IntPtr jobHandle;

    private CcsmProcessJob(IntPtr jobHandle, Process process)
    {
        this.jobHandle = jobHandle;
        Process = process;
    }

    public Process Process { get; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr jobObjectInformation,
        uint jobObjectInformationLength,
        out uint returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr jobObjectInformation,
        uint jobObjectInformationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    public static CcsmProcessJob Start(
        string executable,
        string workingDirectory,
        string dataDirectory)
    {
        var job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObjectW failed");
        }

        var processInformation = new PROCESS_INFORMATION();
        var processCreated = false;
        var processAssigned = false;
        try
        {
            var startupInfo = new STARTUPINFO
            {
                cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO)),
            };
            var commandLine = new StringBuilder(
                QuoteCommandLineArgument(executable) +
                " --ccsm-data-dir " +
                QuoteCommandLineArgument(dataDirectory));
            processCreated = CreateProcessW(
                executable,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CREATE_SUSPENDED,
                IntPtr.Zero,
                workingDirectory,
                ref startupInfo,
                out processInformation);
            if (!processCreated)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
            }

            processAssigned = AssignProcessToJobObject(job, processInformation.hProcess);
            if (!processAssigned)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "AssignProcessToJobObject failed");
            }
            if (ResumeThread(processInformation.hThread) == uint.MaxValue)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
            }

            var process = Process.GetProcessById((int)processInformation.dwProcessId);
            var result = new CcsmProcessJob(job, process);
            job = IntPtr.Zero;
            return result;
        }
        catch (Exception startError)
        {
            Exception cleanupError = null;
            if (processCreated)
            {
                var terminated = false;
                if (processAssigned)
                {
                    terminated = TerminateJobObject(job, 1);
                }
                if (!terminated)
                {
                    terminated = TerminateProcess(processInformation.hProcess, 1);
                }
                if (!terminated)
                {
                    cleanupError = new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Failed to terminate the suspended CCSM process after launch failure");
                }
            }
            if (cleanupError != null)
            {
                throw new AggregateException(
                    "CCSM launch failed and its suspended process could not be terminated",
                    startError,
                    cleanupError);
            }
            throw;
        }
        finally
        {
            if (processInformation.hThread != IntPtr.Zero)
            {
                CloseHandle(processInformation.hThread);
            }
            if (processInformation.hProcess != IntPtr.Zero)
            {
                CloseHandle(processInformation.hProcess);
            }
            if (job != IntPtr.Zero)
            {
                CloseHandle(job);
            }
        }
    }

    public uint[] GetActiveProcessIds()
    {
        EnsureOpen();
        var byteCount = 8 + (IntPtr.Size * MaximumTrackedProcesses);
        var buffer = Marshal.AllocHGlobal(byteCount);
        try
        {
            uint returnedLength;
            if (!QueryInformationJobObject(
                jobHandle,
                JobObjectBasicProcessIdList,
                buffer,
                (uint)byteCount,
                out returnedLength))
            {
                var error = Marshal.GetLastWin32Error();
                var message = error == ERROR_MORE_DATA
                    ? $"Job contains more than {MaximumTrackedProcesses} active processes"
                    : "QueryInformationJobObject failed";
                throw new Win32Exception(error, message);
            }

            var count = Marshal.ReadInt32(buffer, 4);
            var processIds = new List<uint>(count);
            for (var index = 0; index < count; index++)
            {
                var offset = 8 + (index * IntPtr.Size);
                var processId = IntPtr.Size == 8
                    ? unchecked((ulong)Marshal.ReadInt64(buffer, offset))
                    : unchecked((uint)Marshal.ReadInt32(buffer, offset));
                processIds.Add(checked((uint)processId));
            }
            return processIds.ToArray();
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public void EnableKillOnClose()
    {
        EnsureOpen();
        var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        var byteCount = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        var buffer = Marshal.AllocHGlobal(byteCount);
        try
        {
            Marshal.StructureToPtr(information, buffer, false);
            if (!SetInformationJobObject(
                jobHandle,
                JobObjectExtendedLimitInformation,
                buffer,
                (uint)byteCount))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "SetInformationJobObject failed while enabling kill-on-close");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public void Terminate(uint exitCode)
    {
        EnsureOpen();
        if (!TerminateJobObject(jobHandle, exitCode))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "TerminateJobObject failed");
        }
    }

    public void Dispose()
    {
        if (jobHandle != IntPtr.Zero)
        {
            if (!CloseHandle(jobHandle))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CloseHandle failed for job");
            }
            jobHandle = IntPtr.Zero;
        }
    }

    private void EnsureOpen()
    {
        if (jobHandle == IntPtr.Zero)
        {
            throw new ObjectDisposedException(nameof(CcsmProcessJob));
        }
    }

    private static string QuoteCommandLineArgument(string argument)
    {
        if (argument.Length > 0 &&
            argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return argument;
        }

        var result = new StringBuilder(argument.Length + 2);
        result.Append('"');
        var backslashes = 0;
        foreach (var character in argument)
        {
            if (character == '\\')
            {
                backslashes++;
            }
            else if (character == '"')
            {
                result.Append('\\', (backslashes * 2) + 1);
                result.Append('"');
                backslashes = 0;
            }
            else
            {
                result.Append('\\', backslashes);
                result.Append(character);
                backslashes = 0;
            }
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }
}

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
                // Keep the posted stream below the Win32 queue quota so its
                // success rate remains an acceptance signal, while the two
                // synchronous streams still drive the reentrancy race.
                Thread.Sleep(1);
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

function Get-ProcessIdentitySnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [uint32[]]$ProcessIds
    )

    if ($ProcessIds.Count -eq 0) {
        return @()
    }

    $ownedIds = [System.Collections.Generic.HashSet[uint32]]::new()
    foreach ($processId in $ProcessIds) {
        $null = $ownedIds.Add([uint32]$processId)
    }
    $processTable = @(
        Get-CimInstance Win32_Process -ErrorAction Stop |
            Select-Object ProcessId, CreationDate, Name
    )

    return @(
        $processTable |
            Where-Object {
                $null -ne $_.CreationDate -and
                $ownedIds.Contains([uint32]$_.ProcessId)
            } |
            Sort-Object ProcessId |
            ForEach-Object {
                [pscustomobject]@{
                    processId = [uint32]$_.ProcessId
                    creationTimeUtcTicks = ([DateTime]$_.CreationDate).ToUniversalTime().Ticks
                    name = $_.Name
                }
            }
    )
}

function Get-RemainingProcessTreeMembers {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Snapshot
    )

    if ($Snapshot.Count -eq 0) {
        return @()
    }

    $currentProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, CreationDate)
    $currentIdentities = @{}
    foreach ($entry in $currentProcesses) {
        if ($null -ne $entry.CreationDate) {
            $currentIdentities[[uint32]$entry.ProcessId] = ([DateTime]$entry.CreationDate).ToUniversalTime().Ticks
        }
    }

    return @(
        $Snapshot | Where-Object {
            $currentIdentities.ContainsKey([uint32]$_.processId) -and
            $currentIdentities[[uint32]$_.processId] -eq [long]$_.creationTimeUtcTicks
        }
    )
}

$exePath = (Resolve-Path -LiteralPath $Executable).Path
$ownsDataDirectory = [string]::IsNullOrEmpty($DataDirectory)
if (-not $DataDirectory) {
    $DataDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("ccsm-input-deadlock-" + [guid]::NewGuid().ToString("N"))
}
$dataPath = [System.IO.Path]::GetFullPath($DataDirectory)
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null

$process = $null
$processJob = $null
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
$processTreeSnapshot = @()
$jobKillOnCloseEnabled = $false
$jobTerminationRequested = $false
$rootTerminationFallbackUsed = $false
$jobProcessIdsBeforeTermination = @()
$remainingJobProcessIds = @()
$remainingProcessIds = @()
$dataDirectoryCleanupRequested = $false
$dataDirectoryRemoved = $null
$runStartedAt = [DateTimeOffset]::Now
try {
    $processJob = [CcsmProcessJob]::Start(
        $exePath,
        (Split-Path -Parent $exePath),
        $dataPath
    )
    $process = $processJob.Process

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
        ($_.keyboardPostAttempts -gt 0 -and
            (100.0 * $_.keyboardPostFailures / $_.keyboardPostAttempts) -gt
                $MaximumKeyboardPostFailurePercent) -or
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
    try {
        if ($processJob -and -not $KeepProcess) {
            $processTreeCleanupRequested = $true
            $waitCompleted = $false
            $jobStateVerified = $false
            try {
                $processJob.EnableKillOnClose()
                $jobKillOnCloseEnabled = $true
            }
            catch {
                $cleanupErrors.Add("Failed to enable job kill-on-close: $_")
            }
            try {
                $jobProcessIdsBeforeTermination = @($processJob.GetActiveProcessIds())
                $processTreeSnapshot = @(
                    Get-ProcessIdentitySnapshot -ProcessIds $jobProcessIdsBeforeTermination
                )
            }
            catch {
                $cleanupErrors.Add("Failed to capture CCSM job identities before cleanup: $_")
            }
            try {
                $processJob.Terminate(1)
                $jobTerminationRequested = $true
            }
            catch {
                $cleanupErrors.Add("Failed to terminate the CCSM job: $_")
                try {
                    if ($process -and -not $process.HasExited) {
                        $process.Kill($true)
                        $rootTerminationFallbackUsed = $true
                    }
                }
                catch {
                    $cleanupErrors.Add("Failed to terminate the CCSM root process fallback: $_")
                }
            }
            try {
                $waitCompleted = $process.HasExited -or $process.WaitForExit(10000)
            }
            catch {
                $cleanupErrors.Add("Failed while waiting for the CCSM root process: $_")
            }
            try {
                $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(10)
                do {
                    $remainingJobProcessIds = @($processJob.GetActiveProcessIds())
                    $remainingIdentityProcessIds = @(
                        Get-RemainingProcessTreeMembers -Snapshot $processTreeSnapshot |
                            ForEach-Object processId
                    )
                    $remainingProcessIds = @(
                        @($remainingJobProcessIds) + @($remainingIdentityProcessIds) |
                            Sort-Object -Unique
                    )
                    if ($remainingProcessIds.Count -eq 0) {
                        break
                    }
                    Start-Sleep -Milliseconds 100
                } while ([DateTime]::UtcNow -lt $cleanupDeadline)
                $jobStateVerified = $true
            }
            catch {
                $cleanupErrors.Add("Failed to verify CCSM job termination: $_")
            }
            $processTreeTerminated = (
                $waitCompleted -and
                $jobStateVerified -and
                $remainingJobProcessIds.Count -eq 0 -and
                $remainingProcessIds.Count -eq 0
            )
            if (-not $processTreeTerminated) {
                $cleanupErrors.Add("CCSM process tree did not terminate within the cleanup deadline")
            }
        }
    }
    finally {
        if ($processJob) {
            try {
                $processJob.Dispose()
            }
            catch {
                $processTreeTerminated = $false
                $cleanupErrors.Add("Failed to close the CCSM job handle: $_")
            }
        }
    }
    if (
        $ownsDataDirectory -and
        $stressPassed -and
        (-not $processTreeCleanupRequested -or $processTreeTerminated) -and
        $cleanupErrors.Count -eq 0 -and
        -not $KeepProcess -and
        -not $KeepData
    ) {
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
        maximumKeyboardPostFailurePercent = $MaximumKeyboardPostFailurePercent
        minimumCompletedKeyboardMessagesPerRound = $MinimumCompletedKeyboardMessages
        minimumCompletedFocusMessagesPerRound = $MinimumCompletedFocusMessages
        maximumKeyboardFailureStreakMs = $MaximumFocusFailureStreakMilliseconds
        maximumFocusFailureStreakMs = $MaximumFocusFailureStreakMilliseconds
    }
    before = $before
    rounds = $roundResults
    cleanup = [pscustomobject]@{
        mechanism = "Windows Job object assigned before the root process resumes"
        processTreeCleanupRequested = $processTreeCleanupRequested
        processTreeTerminated = $processTreeTerminated
        jobKillOnCloseEnabled = $jobKillOnCloseEnabled
        jobTerminationRequested = $jobTerminationRequested
        rootTerminationFallbackUsed = $rootTerminationFallbackUsed
        jobProcessIdsBeforeTermination = $jobProcessIdsBeforeTermination
        observedProcessCount = $processTreeSnapshot.Count
        observedProcessTree = $processTreeSnapshot
        remainingJobProcessIds = $remainingJobProcessIds
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
