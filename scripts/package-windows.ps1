[CmdletBinding()]
param(
    [string]$Version,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        }
        finally {
            $sha256.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = (Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json).version
}
if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
    throw "Invalid release version: $Version"
}

$releaseRoot = Join-Path $repoRoot "target\release"
$packageName = "CCSM-$Version-windows-x64"
$stageRoot = Join-Path $releaseRoot "package\$packageName"
$zipPath = Join-Path $releaseRoot "$packageName.zip"
$checksumPath = "$zipPath.sha256"
$sourceRevision = (& git -C $repoRoot describe --always --dirty | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "Could not determine source revision"
}

if (-not $SkipBuild) {
    Push-Location $repoRoot
    try {
        pnpm desktop:build:release
        if ($LASTEXITCODE -ne 0) {
            throw "Windows release build failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

$requiredPaths = @(
    (Join-Path $releaseRoot "ccsm-desktop.exe"),
    (Join-Path $releaseRoot "conpty\herdr-conpty.json"),
    (Join-Path $releaseRoot "conpty\conpty.dll"),
    (Join-Path $releaseRoot "conpty\x64\OpenConsole.exe"),
    (Join-Path $releaseRoot "conpty\arm64\OpenConsole.exe"),
    (Join-Path $releaseRoot "THIRD-PARTY-NOTICES\Microsoft.Windows.Console.ConPTY-LICENSE.txt"),
    (Join-Path $releaseRoot "THIRD-PARTY-NOTICES\Microsoft.Windows.Console.ConPTY-NOTICE.md")
)
foreach ($path in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing release artifact: $path"
    }
}

if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
if (Test-Path -LiteralPath $checksumPath) {
    Remove-Item -LiteralPath $checksumPath -Force
}

New-Item -ItemType Directory -Path $stageRoot | Out-Null
$noticeRoot = New-Item -ItemType Directory -Path (Join-Path $stageRoot "THIRD-PARTY-NOTICES")
Copy-Item -LiteralPath (Join-Path $releaseRoot "ccsm-desktop.exe") -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $releaseRoot "conpty") -Destination $stageRoot -Recurse
Copy-Item -LiteralPath (Join-Path $releaseRoot "THIRD-PARTY-NOTICES\Microsoft.Windows.Console.ConPTY-LICENSE.txt") -Destination $noticeRoot
Copy-Item -LiteralPath (Join-Path $releaseRoot "THIRD-PARTY-NOTICES\Microsoft.Windows.Console.ConPTY-NOTICE.md") -Destination $noticeRoot
Copy-Item -LiteralPath (Join-Path $repoRoot "crates\ccsm-platform\vendor\portable-pty\LICENSE.md") -Destination (Join-Path $noticeRoot "portable-pty-LICENSE.md")
Copy-Item -LiteralPath (Join-Path $repoRoot "crates\ccsm-platform\vendor\HERDR-APACHE-2.0.txt") -Destination $noticeRoot
Copy-Item -LiteralPath (Join-Path $repoRoot "crates\ccsm-platform\vendor\NOTICE.md") -Destination (Join-Path $noticeRoot "VENDORED-COMPONENTS.md")
Copy-Item -LiteralPath (Join-Path $repoRoot "README.md") -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $repoRoot "LICENSE") -Destination $stageRoot

$binaryPath = Join-Path $stageRoot "ccsm-desktop.exe"
$binaryHash = Get-Sha256Hex -Path $binaryPath
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines(
    (Join-Path $stageRoot "BUILD-INFO.txt"),
    @(
        "Package: $packageName",
        "Source: $sourceRevision",
        "Built on: $([System.Environment]::OSVersion.VersionString)",
        "Architecture: $env:PROCESSOR_ARCHITECTURE",
        "ccsm-desktop.exe SHA256: $binaryHash"
    ),
    $utf8NoBom
)

Compress-Archive -Path (Join-Path $stageRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal
$archive = Get-Item -LiteralPath $zipPath
$hash = Get-Sha256Hex -Path $zipPath
[System.IO.File]::WriteAllText(
    $checksumPath,
    "$hash  $($archive.Name)`n",
    $utf8NoBom
)
[pscustomobject]@{
    Archive  = $archive.FullName
    Checksum = $checksumPath
    Bytes    = $archive.Length
    SHA256   = $hash
}
