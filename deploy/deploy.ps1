<#
.SYNOPSIS
  Выкладка «Биржи» на сервер прямо с Windows.

.DESCRIPTION
  Упаковывает каталоги server\ и deploy\, копирует архив на сервер по SSH
  и запускает там установку (-Install) или обновление. Нужны встроенные
  в Windows 10/11 клиенты ssh/scp и tar.

.EXAMPLE
  .\deploy\deploy.ps1 -Server 203.0.113.10 -Install -Domain game.example.ru -Email me@example.ru
  Первая установка на чистый сервер с HTTPS.

.EXAMPLE
  .\deploy\deploy.ps1 -Server game.example.ru
  Обновление уже установленной игры (аккаунты и партии сохраняются).
#>
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$User = "root",
  [int]$SshPort = 22,
  [switch]$Install,
  [string]$Domain = "",
  [string]$Email = "",
  [switch]$NoTls,
  [switch]$ImportData
)
$ErrorActionPreference = "Stop"

# Значения уходят в командную строку на сервере — пропускаем только безопасные символы.
if ($Server -notmatch '^[A-Za-z0-9.:\-\[\]]+$') { throw "Некорректный адрес сервера: $Server" }
if ($User -notmatch '^[a-z_][a-z0-9_\-]*$') { throw "Некорректное имя пользователя: $User" }
if ($Domain -and $Domain -notmatch '^[A-Za-z0-9]([A-Za-z0-9.\-]*[A-Za-z0-9])?$') { throw "Некорректный домен: $Domain" }
if ($Email -and $Email -notmatch '^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+$') { throw "Некорректный email: $Email" }

foreach ($tool in "ssh", "scp", "tar") {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "Не найден $tool. Включите «Клиент OpenSSH» в Параметры → Приложения → Дополнительные компоненты."
  }
}

$root = Split-Path -Parent $PSScriptRoot
$archive = Join-Path $env:TEMP "birzha-deploy.tgz"
if (Test-Path $archive) { Remove-Item $archive -Force }

$tarArgs = @("-czf", $archive, "--exclude=server/node_modules", "--exclude=server/.claude", "--exclude=*.log")
if ($ImportData) {
  # Переносим только аккаунты; служебные файлы локального сервера не нужны.
  $tarArgs += @("--exclude=server/data/rooms.json*", "--exclude=server/data/backups")
} else {
  $tarArgs += "--exclude=server/data"
}
$tarArgs += @("server", "deploy")

Push-Location $root
try {
  Write-Host "==> Упаковываю server\ и deploy\" -ForegroundColor Green
  & tar @tarArgs
  if ($LASTEXITCODE -ne 0) { throw "tar завершился с ошибкой $LASTEXITCODE" }
} finally { Pop-Location }

$target = "$User@$Server"
Write-Host "==> Копирую на $target" -ForegroundColor Green
# Относительное имя: путь вида C:\... scp мог бы принять за «хост:путь».
Push-Location (Split-Path -Parent $archive)
try {
  & scp -P $SshPort (Split-Path -Leaf $archive) "${target}:/tmp/birzha-deploy.tgz"
  if ($LASTEXITCODE -ne 0) { throw "Не удалось скопировать архив (scp $LASTEXITCODE)" }
} finally { Pop-Location }

$sudo = if ($User -eq "root") { "" } else { "sudo " }
$tmp = "/tmp/birzha-deploy"
if ($Install) {
  $opts = @()
  if ($Domain) { $opts += "--domain $Domain" }
  if ($Email) { $opts += "--email $Email" }
  if ($NoTls -or -not $Domain) { $opts += "--no-tls" }
  if ($ImportData) { $opts += "--import-data" }
  $run = "${sudo}bash $tmp/deploy/install.sh " + ($opts -join " ")
} else {
  $run = "${sudo}bash $tmp/deploy/update.sh"
}
# CRLF → LF: bash не выполнит скрипт с виндовыми переводами строк.
$remote = "set -e; rm -rf $tmp; mkdir -p $tmp; tar -xzf /tmp/birzha-deploy.tgz -C $tmp; " +
  "find $tmp/deploy -type f -exec sed -i 's/\r`$//' {} +; " +
  "$run; rm -rf $tmp /tmp/birzha-deploy.tgz"

Write-Host "==> Запускаю на сервере: $run" -ForegroundColor Green
& ssh -t -p $SshPort $target $remote
if ($LASTEXITCODE -ne 0) { throw "Команда на сервере завершилась с ошибкой $LASTEXITCODE" }
Remove-Item $archive -Force -ErrorAction SilentlyContinue
Write-Host "==> Готово" -ForegroundColor Green
