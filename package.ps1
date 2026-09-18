$sourcePath = Get-Location
$destinationPath = Join-Path -Path $sourcePath -ChildPath "canvas-video-dl.zip"

if (Test-Path $destinationPath) {
    Remove-Item $destinationPath -Force
}

$exclude = @(".git", ".vscode", "package.ps1", "plans", "*.zip", "icon.jpg", "README.md")
$itemsToCompress = Get-ChildItem -Path $sourcePath -Exclude $exclude

Compress-Archive -Path $itemsToCompress.FullName -DestinationPath $destinationPath -Force

Write-Host "Extension successfully packaged to: $destinationPath"
