param([Parameter(Mandatory=$true)][int]$RootPid, [switch]$Fingerprint)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath)
$ids = [System.Collections.Generic.HashSet[int]]::new()
[void]$ids.Add($RootPid)
do {
    $added = $false
    foreach ($row in $all) {
        if ($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $added = $true }
    }
} while ($added)
$processes = @($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
if (-not ($processes | Where-Object Id -eq $RootPid)) { throw 'Application process exited' }
$result = @{
    privateBytes = [double](($processes | Measure-Object PrivateMemorySize64 -Sum).Sum)
    workingSetBytes = [double](($processes | Measure-Object WorkingSet64 -Sum).Sum)
    processCount = $processes.Count
    gpuBytes = $null
}
if ($Fingerprint) {
    Add-Type -AssemblyName System.Windows.Forms
    $webview = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) -and $_.ExecutablePath -match 'msedgewebview2.exe$' } | Select-Object -First 1)
    if (-not $webview.Count) { throw 'WebView2 process missing' }
    $result.environment = @{
        os = [Environment]::OSVersion.VersionString
        cpu = @(Get-CimInstance Win32_Processor | ForEach-Object Name)
        gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | Sort-Object Name)
        webview2 = (Get-Item -LiteralPath $webview[0].ExecutablePath).VersionInfo.ProductVersion
        screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.ToString()
        logicalProcessors = [Environment]::ProcessorCount
        powerPlan = [regex]::Match(((powercfg /getactivescheme) -join ''), '[0-9a-fA-F-]{36}').Value
    }
}
$result | ConvertTo-Json -Depth 8 -Compress
