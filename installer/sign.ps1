# 给 exe 打 Authenticode 签名（本机自签名证书）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\sign.ps1 -Path dist\xxx.exe
#   powershell ... -File installer\sign.ps1 -Path dist\xxx.exe -Thumbprint 591ECB...
#
# 证书从 CurrentUser\My 里找（CodeSigningCert），找不到就退出码 2。
# 注意：这是**自签名**——本机装了这张证书才算「受信任」，别人电脑上一样会提示
# 「未知发布者」。要真正消除警告只能买 CA 证书，或用 SignPath 这类给开源项目的免费签名服务。

param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Thumbprint = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

if (-not (Test-Path $Path)) {
  Write-Error "找不到文件：$Path"
  exit 1
}

if ($Thumbprint) {
  $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object { $_.Thumbprint -eq $Thumbprint } | Select-Object -First 1
} else {
  $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
    Where-Object { $_.Subject -like '*NisssOwO*' } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
  if (-not $cert) {
    $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Sort-Object NotAfter -Descending | Select-Object -First 1
  }
}

if (-not $cert) {
  Write-Host '没有可用的代码签名证书（CurrentUser\My 里没有 CodeSigningCert）。'
  exit 2
}

$sig = Set-AuthenticodeSignature -Certificate $cert -FilePath $Path -HashAlgorithm SHA256

# 自签名的链一定不可信，Status 不会是 Valid；看有没有写入签名就行
$check = Get-AuthenticodeSignature -FilePath $Path
$hasSig = [bool]$check.SignerCertificate

Write-Host ("签名者  : " + $cert.Subject)
Write-Host ("指纹    : " + $cert.Thumbprint)
Write-Host ("有效期  : " + $cert.NotAfter.ToString('yyyy-MM-dd'))
Write-Host ("签名写入: " + $hasSig)
Write-Host ("验证状态: " + $check.Status + " —— " + $check.StatusMessage)

if (-not $hasSig) { exit 1 }
exit 0
