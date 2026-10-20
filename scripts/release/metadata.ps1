param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $Path
$signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
$version = $item.VersionInfo.ProductVersion
if ($item.Extension -eq '.msi') {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.OpenDatabase($item.FullName, 0)
    $view = $database.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property``='ProductVersion'")
    $view.Execute()
    $row = $view.Fetch()
    if (-not $row) { throw 'MSI ProductVersion missing' }
    $version = $row.StringData(1)
    $view.Close()
}
@{ version = $version; productName = $item.VersionInfo.ProductName; authenticode = [string]$signature.Status } | ConvertTo-Json -Compress
