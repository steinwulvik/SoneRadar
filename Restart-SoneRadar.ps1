$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding
$port = 4173
$serverFile = Join-Path $PSScriptRoot 'server.cjs'

Write-Host 'Ser etter SoneRadar-serveren på port 4173 …'
$listeners = @(netstat.exe -ano -p tcp |
    Select-String "^\s*TCP\s+\S+:$port\s+\S+\s+LISTENING\s+(\d+)\s*$" |
    ForEach-Object { [int]$_.Matches[0].Groups[1].Value } |
    Select-Object -Unique)

foreach ($processId in $listeners) {
    $processInfo = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($processInfo.ProcessName -ne 'node') {
        Write-Host "Port $port brukes av en annen prosess (PID $processId). Den ble ikke stoppet."
        Write-Host 'Stopp den prosessen selv, eller endre porten i serverkonfigurasjonen.'
        exit 1
    }
    Write-Host "Stopper eksisterende Node-server (PID $processId) …"
    Stop-Process -Id $processId -Force
}

if ($listeners.Count -gt 0) {
    $deadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 250
        $stillListening = @(netstat.exe -ano -p tcp | Select-String "^\s*TCP\s+\S+:$port\s+\S+\s+LISTENING\s+(\d+)\s*$")
    } while ($stillListening.Count -gt 0 -and (Get-Date) -lt $deadline)
    if ($stillListening.Count -gt 0) {
        Write-Host "Port $port er fortsatt opptatt. Serveren ble ikke startet på nytt."
        exit 1
    }
}

function Test-PortAvailable([int]$candidatePort) {
    $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $candidatePort)
    try { $probe.Start(); return $true } catch { return $false } finally { $probe.Stop() }
}
if (-not (Test-PortAvailable $port)) {
    $availablePort = 4174
    while ($availablePort -le 4190 -and -not (Test-PortAvailable $availablePort)) { $availablePort++ }
    if ($availablePort -gt 4190) { Write-Host 'Ingen ledig lokal port mellom 4173 og 4190.'; exit 1 }
    Write-Host "Port 4173 er opptatt og kunne ikke restartes her. Starter denne versjonen på port $availablePort i stedet."
    $port = $availablePort
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeCandidates = @(
    $nodeCommand.Source,
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
)
$nodeExe = $nodeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $nodeExe) {
    Write-Host 'Node.js ble ikke funnet. Installer Node.js 22 eller nyere.'
    exit 1
}

Set-Location $PSScriptRoot
$env:PORT = [string]$port
$env:HOST = '127.0.0.1'
Write-Host "Starter SoneRadar på http://127.0.0.1:$port …"
& $nodeExe $serverFile
