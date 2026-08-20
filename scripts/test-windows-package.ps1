[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$DataDirectory,
    [string]$UpdateArtifactPath,
    [string]$UpdateSignaturePath,
    [string]$BaseVersion,
    [string]$CandidateVersion,
    [int]$EndpointPort,
    [int]$DriverPort,
    [string]$ArtifactDirectory
)

$ErrorActionPreference = "Stop"
$existing = @(Get-Process -Name "ccsm-desktop" -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
    throw "Refusing installer smoke with a pre-existing ccsm-desktop process"
}

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$dataRoot = [IO.Path]::GetFullPath($DataDirectory)
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$runInstalledUpdater = -not [string]::IsNullOrWhiteSpace($UpdateArtifactPath)
if ($runInstalledUpdater) {
    foreach ($required in @{
        UpdateSignaturePath = $UpdateSignaturePath
        BaseVersion = $BaseVersion
        CandidateVersion = $CandidateVersion
        EndpointPort = $EndpointPort
        DriverPort = $DriverPort
    }.GetEnumerator()) {
        if ([string]::IsNullOrWhiteSpace([string]$required.Value) -or [string]$required.Value -eq "0") {
            throw "$($required.Key) is required for installed updater E2E"
        }
    }
    $updateArtifact = (Resolve-Path -LiteralPath $UpdateArtifactPath).Path
    $updateSignature = (Resolve-Path -LiteralPath $UpdateSignaturePath).Path
    if ([string]::IsNullOrWhiteSpace($ArtifactDirectory)) {
        $ArtifactDirectory = Join-Path $dataRoot "installed-update-e2e"
    }
    $ArtifactDirectory = [IO.Path]::GetFullPath($ArtifactDirectory)
    New-Item -ItemType Directory -Path $ArtifactDirectory -Force | Out-Null
}
$entry = $null
$installLocation = $null
$restartedProcess = $null

try {
    Start-Process -FilePath $installer -ArgumentList "/S" -Wait
    $entry = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" |
        ForEach-Object { Get-ItemProperty $_.PSPath } |
        Where-Object { $_.DisplayName -eq "CCSM" } |
        Select-Object -First 1
    if (-not $entry -or -not $entry.InstallLocation) {
        throw "CCSM InstallLocation was not registered"
    }
    $installLocation = ([string]$entry.InstallLocation).Trim().Trim('"')
    $installLocation = [IO.Path]::GetFullPath($installLocation)
    $executable = Join-Path $installLocation "ccsm-desktop.exe"
    foreach ($relative in @(
        "ccsm-desktop.exe",
        "conpty/conpty.dll",
        "conpty/herdr-conpty.json",
        "conpty/x64/OpenConsole.exe"
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $installLocation $relative) -PathType Leaf)) {
            throw "Missing installed file: $relative"
        }
    }

    if ($runInstalledUpdater) {
        $runner = Join-Path $PSScriptRoot "..\apps\desktop\scripts\run-installed-update-e2e.mjs"
        $runnerArguments = @(
            $runner,
            "--app-binary", $executable,
            "--update-artifact", $updateArtifact,
            "--update-signature", $updateSignature,
            "--target", "windows-x86_64-nsis",
            "--base-version", $BaseVersion,
            "--candidate-version", $CandidateVersion,
            "--endpoint-port", [string]$EndpointPort,
            "--driver-port", [string]$DriverPort,
            "--data-dir", $dataRoot,
            "--output-dir", $ArtifactDirectory,
            "--variant", "windows-nsis"
        )
        & node @runnerArguments
        if ($LASTEXITCODE -ne 0) {
            throw "Installed NSIS updater E2E failed with exit code $LASTEXITCODE"
        }
        $updatedEntry = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" |
            ForEach-Object { Get-ItemProperty $_.PSPath } |
            Where-Object { $_.DisplayName -eq "CCSM" } |
            Select-Object -First 1
        if ([string]$updatedEntry.DisplayVersion -ne $CandidateVersion) {
            throw "Expected installed version $CandidateVersion, received $($updatedEntry.DisplayVersion)"
        }
        [pscustomobject]@{
            Installer = $installer
            InstallLocation = $installLocation
            BaseVersion = $BaseVersion
            CandidateVersion = $CandidateVersion
            Updated = $true
            Flow = "settings-signed-update"
        }
    }
    else {
        $process = Start-Process -FilePath $executable -ArgumentList "--ccsm-data-dir=$dataRoot" -PassThru
        Start-Sleep -Seconds 8
        if ($process.HasExited) {
            throw "Installed CCSM exited during smoke test"
        }

        $initialPid = $process.Id
        $upgrade = Start-Process -FilePath $installer -ArgumentList "/P", "/UPDATE", "/R" -PassThru
        if (-not $upgrade.WaitForExit(60000)) {
            throw "NSIS passive update did not finish within 60 seconds"
        }
        if ($upgrade.ExitCode -ne 0) {
            throw "NSIS passive update exited with $($upgrade.ExitCode)"
        }
        if (-not $process.WaitForExit(20000)) {
            throw "NSIS update left the original CCSM process running"
        }

        $restarted = $null
        for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
            $restarted = Get-CimInstance Win32_Process |
                Where-Object {
                    $_.ProcessId -ne $initialPid -and
                    $_.ExecutablePath -and
                    ([IO.Path]::GetFullPath($_.ExecutablePath) -eq [IO.Path]::GetFullPath($executable))
                } |
                Select-Object -First 1
            if ($restarted) { break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $restarted) {
            throw "NSIS update did not restart CCSM"
        }
        $restartedProcess = Get-Process -Id $restarted.ProcessId
        [void]$restartedProcess.CloseMainWindow()
        if (-not $restartedProcess.WaitForExit(20000)) {
            throw "Restarted CCSM did not close cleanly"
        }

        [pscustomobject]@{
            Installer = $installer
            InstallLocation = $installLocation
            InitialPid = $initialPid
            RestartedPid = $restarted.ProcessId
            Updated = $true
            Flow = "installer-smoke"
        }
    }
}
finally {
    if ($installLocation) {
        $executable = Join-Path $installLocation "ccsm-desktop.exe"
        $ownedProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'ccsm-desktop.exe'" |
            Where-Object {
                $_.ExecutablePath -and
                ([IO.Path]::GetFullPath($_.ExecutablePath) -eq [IO.Path]::GetFullPath($executable))
            })
        foreach ($owned in $ownedProcesses) {
            $ownedProcess = Get-Process -Id $owned.ProcessId -ErrorAction SilentlyContinue
            if ($ownedProcess) {
                [void]$ownedProcess.CloseMainWindow()
                if (-not $ownedProcess.WaitForExit(10000)) {
                    Stop-Process -Id $owned.ProcessId -Force
                }
            }
        }
        $uninstaller = Join-Path $installLocation "uninstall.exe"
        if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
            Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait
        }
    }
}
