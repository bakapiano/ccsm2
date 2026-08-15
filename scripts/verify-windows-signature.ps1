[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Path,

    [string]$ExpectedSubject
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Signed file does not exist: $Path"
}

$resolvedPath = (Resolve-Path -LiteralPath $Path).Path
$signature = Get-AuthenticodeSignature -FilePath $resolvedPath
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Authenticode signature is not valid for $resolvedPath`: $($signature.Status) ($($signature.StatusMessage))"
}

$signer = $signature.SignerCertificate
if ($null -eq $signer) {
    throw "Authenticode signature has no signer certificate: $resolvedPath"
}

$codeSigningOid = "1.3.6.1.5.5.7.3.3"
$hasCodeSigningEku = $false
foreach ($extension in $signer.Extensions) {
    if ($extension -isnot [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]) {
        continue
    }
    foreach ($usage in $extension.EnhancedKeyUsages) {
        if ($usage.Value -eq $codeSigningOid) {
            $hasCodeSigningEku = $true
            break
        }
    }
}
if (-not $hasCodeSigningEku) {
    throw "Authenticode signer certificate has no Code Signing EKU: $($signer.Subject)"
}

if (-not [string]::IsNullOrWhiteSpace($ExpectedSubject) -and $signer.Subject -ne $ExpectedSubject) {
    throw "Authenticode signer subject mismatch: expected '$ExpectedSubject', got '$($signer.Subject)'"
}

$timestamp = $signature.TimeStamperCertificate
if ($null -eq $timestamp) {
    throw "Authenticode signature has no trusted timestamp: $resolvedPath"
}

[pscustomobject]@{
    Path                 = $resolvedPath
    Status               = $signature.Status.ToString()
    SignerSubject        = $signer.Subject
    SignerThumbprint     = $signer.Thumbprint
    TimestampSubject     = $timestamp.Subject
    TimestampThumbprint  = $timestamp.Thumbprint
}
