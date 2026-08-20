[CmdletBinding()]
param(
    [string]$Version,
    [switch]$SkipBuild,
    [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-SingleFile {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$Filter
    )

    $files = @(Get-ChildItem -LiteralPath $Directory -File -Filter $Filter)
    if ($files.Count -ne 1) {
        throw "Expected one $Filter in $Directory, found $($files.Count)"
    }
    return $files[0]
}

function Copy-VersionedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )

    $destination = Join-Path $DestinationRoot $Name
    Copy-Item -LiteralPath $Source -Destination $destination -Force
    return Get-Item -LiteralPath $destination
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = (Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json).version
}
if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
    throw "Invalid release version: $Version"
}

$releaseRoot = Join-Path $repoRoot "target\release"
$bundleRoot = Join-Path $releaseRoot "bundle\nsis"
if ([string]::IsNullOrWhiteSpace($OutputDirectory) -and -not [string]::IsNullOrWhiteSpace($env:CCSM_PACKAGE_OUTPUT_DIR)) {
    $OutputDirectory = $env:CCSM_PACKAGE_OUTPUT_DIR
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $releaseRoot "dist"
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)

if (-not $SkipBuild) {
    Push-Location $repoRoot
    try {
        pnpm desktop:build:release
        if ($LASTEXITCODE -ne 0) {
            throw "Windows bundle build failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $bundleRoot -PathType Container)) {
    throw "Missing NSIS bundle directory: $bundleRoot"
}
$installer = Get-SingleFile -Directory $bundleRoot -Filter "*_$($Version)_x64-setup.exe"
$signatureFiles = @(Get-ChildItem -LiteralPath $bundleRoot -File -Filter "*_$($Version)_x64-setup.exe*.sig")
if ($signatureFiles.Count -ne 1) {
    throw "Expected one updater signature in $bundleRoot, found $($signatureFiles.Count)"
}
$signature = $signatureFiles[0]
$signedPayloadPath = $signature.FullName.Substring(0, $signature.FullName.Length - 4)
if (-not (Test-Path -LiteralPath $signedPayloadPath -PathType Leaf)) {
    throw "Updater signature has no payload: $($signature.FullName)"
}
$signedPayload = Get-Item -LiteralPath $signedPayloadPath

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$installerName = "CCSM-$Version-windows-x64-setup.exe"
$outputFiles = @(
    (Copy-VersionedFile -Source $installer.FullName -Name $installerName -DestinationRoot $OutputDirectory)
)

if ($signedPayload.Extension -eq ".exe") {
    $updaterName = $installerName
    $updater = $outputFiles[0]
}
elseif ($signedPayload.Name.EndsWith(".zip", [StringComparison]::OrdinalIgnoreCase)) {
    $updaterName = "CCSM-$Version-windows-x64.nsis.zip"
    $updater = Copy-VersionedFile -Source $signedPayload.FullName -Name $updaterName -DestinationRoot $OutputDirectory
    $outputFiles += $updater
}
else {
    throw "Unexpected NSIS updater payload: $($signedPayload.Name)"
}
$outputFiles += (Copy-VersionedFile -Source $signature.FullName -Name "$updaterName.sig" -DestinationRoot $OutputDirectory)

$checksumPath = Join-Path $OutputDirectory "SHA256SUMS-windows-x64.txt"
$checksumLines = $outputFiles |
    Where-Object { -not $_.Name.EndsWith(".sig", [StringComparison]::OrdinalIgnoreCase) } |
    Sort-Object Name -Unique |
    ForEach-Object { "$(Get-Sha256Hex -Path $_.FullName)  $($_.Name)" }
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($checksumPath, (($checksumLines -join "`n") + "`n"), $utf8NoBom)

[pscustomobject]@{
    Installer = $outputFiles[0].FullName
    Updater   = $updater.FullName
    Signature = (Join-Path $OutputDirectory "$updaterName.sig")
    Checksums = $checksumPath
}
