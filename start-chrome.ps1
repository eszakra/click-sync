$profileDir = "$env:TEMP\chrome-devtools-mcp-profile"
if (Test-Path $profileDir) { 
    Remove-Item -Recurse -Force $profileDir 
}
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$arguments = @(
    '--remote-debugging-port=9222',
    "--user-data-dir=$profileDir",
    '--no-first-run',
    '--no-default-browser-check'
)

Start-Process -FilePath 'chrome' -ArgumentList $arguments -WindowStyle Normal
Write-Host 'Chrome iniciado en puerto 9222'
