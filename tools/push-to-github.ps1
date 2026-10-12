<#
.SYNOPSIS
  Отправка этой копии проекта на GitHub в отдельную ветку — оттуда GitHub Actions
  соберёт APK.

.DESCRIPTION
  Скрипт для владельца (Windows PowerShell 5.1 и новее, нужен Git for Windows).
  1. Клонирует репозиторий (по умолчанию https://github.com/XSTATEM/MonopolyGame)
     во временную папку или берёт уже готовый клон (-ClonePath).
  2. Переносит в клон файлы этой папки проекта — без node_modules, server\data,
     mobile\www, mobile\android, *.log, .claude и черновых папок scratch.
     Файлы, которых в проекте больше нет, удаляются и в клоне.
  3. Показывает, что изменилось, и после подтверждения коммитит в ветку
     (по умолчанию feature/<дата>) и отправляет её на GitHub вашими учётными
     данными git (окно входа Git Credential Manager или SSH-ключ).
  4. Печатает, где искать сборку APK.

  Никакого force-push. В master (или другую основную ветку) — только если явно
  указать -Branch master и подтвердить вводом имени ветки: сборка из master
  публикуется как общая ссылка android-latest для всех игроков.
  Подробности — GITHUB.md в корне проекта.

.PARAMETER Repo
  Репозиторий: https://github.com/<владелец>/<имя>, <владелец>/<имя>,
  git@github.com:<владелец>/<имя>.git или путь к локальному репозиторию.

.PARAMETER Branch
  Ветка для отправки. По умолчанию feature/<год-месяц-день>. Если такая ветка уже
  есть на GitHub, новый коммит ляжет поверх неё (обычный push, без перезаписи).

.PARAMETER Message
  Текст коммита. По умолчанию «Обновление из локальной копии от <дата>».

.PARAMETER Base
  От какой ветки отводить новую ветку. По умолчанию — основная ветка репозитория.

.PARAMETER ClonePath
  Папка с готовым клоном (должна быть без незакоммиченных изменений) или куда
  клонировать. По умолчанию — %TEMP%\tm-push-<владелец>-<имя>; эту папку скрипт
  считает своей и при следующем запуске приводит в порядок сам.

.PARAMETER Source
  Папка проекта. По умолчанию — родительская для tools\.

.PARAMETER DryRun
  Пробный запуск: показать изменения, ничего не коммитить и не отправлять.

.PARAMETER Yes
  Не спрашивать «Отправить?» (подтверждение для master всё равно спрашивается).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\push-to-github.ps1 -DryRun
  Посмотреть, что уйдёт на GitHub, ничего не отправляя.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\push-to-github.ps1 -Message "Магазин, новое меню, сборки для RuStore и Google Play"
  Отправить в ветку feature/<сегодняшняя дата>.

.EXAMPLE
  .\tools\push-to-github.ps1 -Branch feature/monetization -ClonePath D:\git\MonopolyGame
  Отправить в свою ветку, используя уже имеющийся клон.
#>
[CmdletBinding()]
param(
  [string]$Repo = "https://github.com/XSTATEM/MonopolyGame",
  [string]$Branch = "",
  [string]$Message = "",
  [string]$Base = "",
  [string]$ClonePath = "",
  [string]$Source = "",
  [switch]$DryRun,
  [switch]$Yes
)
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------
# Что не переносим в репозиторий. Имена папок исключаются на любой глубине,
# пути — относительно корня проекта. Такие файлы в клоне скрипт не трогает:
# не копирует и не удаляет.
# ---------------------------------------------------------------------
$ExcludeDirNames = @(".git", "node_modules", ".claude", "scratch", "scratchpad")
$ExcludeRelDirs = @("server/data", "mobile/www", "mobile/android", "mobile/ios")
$ExcludeFiles = @("*.log", ".native-build.json", "Thumbs.db", "desktop.ini")
# GitHub не принимает файлы больше 100 МБ.
$MaxFileBytes = 95MB

function Say([string]$text) { Write-Host "==> $text" -ForegroundColor Green }
function Warn([string]$text) { Write-Host "Внимание: $text" -ForegroundColor Yellow }

# git пишет ход работы в stderr, а Windows PowerShell 5.1 при «Stop» в некоторых
# окнах (например, в ISE) превращает такой вывод в исключение. Поэтому git
# запускаем с «Continue» и судим об успехе только по коду выхода.
function Invoke-GitShow([string[]]$GitArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & git @GitArgs | Out-Host; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
  if ($code -ne 0) { throw "Команда «git $($GitArgs -join ' ')» завершилась с ошибкой ($code)." }
}
function Get-GitOutput([string[]]$GitArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { $out = @(& git @GitArgs); $code = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
  if ($code -ne 0) { throw "Команда «git $($GitArgs -join ' ')» завершилась с ошибкой ($code)." }
  return ,$out
}
# Тихая проверка: $true, если git завершился успешно.
function Test-Git([string[]]$GitArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & git @GitArgs > $null 2> $null; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
  return ($code -eq 0)
}

# Адрес репозитория → {Url, Owner, Name, Web, Local}. Локальная папка — только
# для проверки скрипта без GitHub.
function Resolve-Repo([string]$text) {
  $t = $text.Trim()
  $isUrl = $t -match '^(https://|git@|ssh://)'
  if (-not $isUrl -and (Test-Path -LiteralPath $t -PathType Container)) {
    $full = (Resolve-Path -LiteralPath $t).ProviderPath
    return [pscustomobject]@{ Url = $full; Owner = "local"; Name = (Split-Path -Leaf $full); Web = ""; Local = $true }
  }
  if ($t -match '^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)?([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$') {
    $owner = $Matches[1]
    $name = $Matches[2]
    $url = "https://github.com/$owner/$name.git"
    if ($t -match '^(git@|ssh://)') { $url = $t }
    return [pscustomobject]@{ Url = $url; Owner = $owner; Name = $name; Web = "https://github.com/$owner/$name"; Local = $false }
  }
  throw "Не понимаю адрес репозитория «$text». Пример: https://github.com/XSTATEM/MonopolyGame или XSTATEM/MonopolyGame."
}
# Тот ли это репозиторий (адрес origin у готового клона).
function Test-SameRepo([string]$originUrl, $info) {
  if ($info.Local) {
    if (-not (Test-Path -LiteralPath $originUrl)) { return $false }
    return ((Resolve-Path -LiteralPath $originUrl).ProviderPath.TrimEnd('\') -ieq $info.Url.TrimEnd('\'))
  }
  if ($originUrl -match 'github\.com[:/]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$') {
    return (($Matches[1] -ieq $info.Owner) -and ($Matches[2] -ieq $info.Name))
  }
  return $false
}

# Файл или папка из списка исключений? rel — путь git (через «/»).
function Test-Excluded([string]$rel) {
  $parts = $rel -split '/'
  for ($i = 0; $i -lt $parts.Count - 1; $i++) {
    if ($ExcludeDirNames -contains $parts[$i]) { return $true }
  }
  foreach ($d in $ExcludeRelDirs) {
    if ($rel.StartsWith($d + "/", [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  $leaf = $parts[$parts.Count - 1]
  foreach ($p in $ExcludeFiles) { if ($leaf -like $p) { return $true } }
  return $false
}

# Тег релиза с APK — как его считает .github/workflows/android.yml (задача release):
# master → android-latest; иначе android-branch-<ветка, где всё, кроме
# латиницы, цифр, «_» и «-», заменено на «-», до 40 символов>-<7 знаков sha1 имени ветки>.
function Get-ReleaseTag([string]$name) {
  if ($name -ceq "master") { return "android-latest" }
  $slug = $name -replace '[^A-Za-z0-9_-]', '-'
  if ($slug.Length -gt 40) { $slug = $slug.Substring(0, 40) }
  $sha1 = [System.Security.Cryptography.SHA1]::Create()
  try { $bytes = $sha1.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($name)) } finally { $sha1.Dispose() }
  $hex = -join ($bytes | ForEach-Object { $_.ToString("x2") })
  return ("android-branch-{0}-{1}" -f $slug, $hex.Substring(0, 7))
}

# Вывод git (имена файлов по-русски) — в UTF-8; в конце возвращаем как было.
$prevOutputEncoding = $null
try { $prevOutputEncoding = [Console]::OutputEncoding; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { $prevOutputEncoding = $null }

$G = @()
$clone = ""
$touched = $false
$createdBranch = $false
$startBranch = ""
$committed = $false

# Вернуть клон в состояние до переноса файлов (отмена, ошибка или пробный запуск).
# Перед переносом клон был чистым, поэтому так убираются только наши изменения.
function Restore-Clone {
  if (-not $clone) { return }
  if ($touched) {
    Test-Git ($G + @("reset", "-q", "--hard")) | Out-Null
    Test-Git ($G + @("clean", "-q", "-fd")) | Out-Null
  }
  if ($createdBranch -and $startBranch -and $startBranch -ne $Branch) {
    if (Test-Git ($G + @("checkout", "-q", $startBranch))) { Test-Git ($G + @("branch", "-q", "-D", $Branch)) | Out-Null }
  }
}

try {
  # --- Проверки до любых действий ----------------------------------------
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Не найден git. Установите Git for Windows (https://git-scm.com/download/win) и откройте новое окно PowerShell."
  }
  if (-not (Get-Command robocopy -ErrorAction SilentlyContinue)) { throw "Не найден robocopy (входит в Windows)." }

  if (-not $Source) { $Source = Split-Path -Parent $PSScriptRoot }
  $Source = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Source).TrimEnd('\')
  foreach ($must in @("server\server.js", "mobile\package.json", ".github\workflows\android.yml")) {
    if (-not (Test-Path -LiteralPath (Join-Path $Source $must))) { throw "В $Source нет $must — укажите папку проекта: -Source <путь>." }
  }

  $info = Resolve-Repo $Repo

  $branchGiven = $PSBoundParameters.ContainsKey("Branch") -and $Branch
  if (-not $Branch) { $Branch = "feature/" + (Get-Date -Format "yyyy-MM-dd") }
  if ($Branch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$' -or $Branch -match '\.\.|//|/$|\.$|\.lock$|/\.') {
    throw "Недопустимое имя ветки «$Branch»: латиница, цифры, «.», «_», «-» и «/», например feature/monetization."
  }
  if (-not (Test-Git @("check-ref-format", "--branch", $Branch))) { throw "git не принимает имя ветки «$Branch»." }
  if ($Base -and $Base -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$') { throw "Недопустимое имя базовой ветки «$Base»." }
  if (-not $Message) { $Message = "Обновление из локальной копии от " + (Get-Date -Format "dd.MM.yyyy HH:mm") }

  $ownClone = $false
  if (-not $ClonePath) {
    $ClonePath = Join-Path $env:TEMP ("tm-push-{0}-{1}" -f $info.Owner, $info.Name)
    $ownClone = $true
  }
  $clonePathFull = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ClonePath).TrimEnd('\')
  if ($clonePathFull -ieq $Source -or
      $clonePathFull.StartsWith($Source + "\", [StringComparison]::OrdinalIgnoreCase) -or
      $Source.StartsWith($clonePathFull + "\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Папка клона ($clonePathFull) не должна совпадать с папкой проекта или лежать внутри неё (и наоборот)."
  }

  # --- Клон ---------------------------------------------------------------
  $G = @("-C", $clonePathFull, "-c", "core.quotepath=false")
  if (Test-Path -LiteralPath (Join-Path $clonePathFull ".git")) {
    $origin = ""
    if (Test-Git ($G + @("remote", "get-url", "origin"))) {
      $o = Get-GitOutput ($G + @("remote", "get-url", "origin"))
      if ($o.Count) { $origin = [string]$o[0] }
    }
    if (-not (Test-SameRepo $origin $info)) { throw "В $clonePathFull клон другого репозитория ($origin). Укажите другую папку: -ClonePath <путь>." }
    if ($ownClone) {
      # Своя папка скрипта: остатки прошлого запуска (пробный прогон, отмена) убираем.
      Invoke-GitShow ($G + @("reset", "-q", "--hard"))
      Invoke-GitShow ($G + @("clean", "-q", "-fd"))
    } else {
      $dirty = Get-GitOutput ($G + @("status", "--porcelain"))
      if ($dirty.Count) {
        throw "В клоне $clonePathFull есть незакоммиченные изменения. Закоммитьте или уберите их (git status) — скрипт не будет их перезаписывать."
      }
    }
    # Только теперь клон считается «нашим»: при ошибке дальше его можно вернуть как было.
    $clone = $clonePathFull
    Say "Обновляю клон $clonePathFull"
    Invoke-GitShow ($G + @("fetch", "--prune", "origin"))
  } else {
    if ((Test-Path -LiteralPath $clonePathFull) -and @(Get-ChildItem -LiteralPath $clonePathFull -Force).Count) {
      throw "Папка $clonePathFull не пуста и это не git-клон. Укажите другую: -ClonePath <путь>."
    }
    Say ("Клонирую {0} в {1}" -f $info.Url, $clonePathFull)
    Invoke-GitShow @("clone", $info.Url, $clonePathFull)
    $clone = $clonePathFull
  }

  # Основная ветка репозитория (обычно master).
  $defaultBranch = ""
  if (-not (Test-Git ($G + @("symbolic-ref", "-q", "refs/remotes/origin/HEAD")))) {
    Test-Git ($G + @("remote", "set-head", "origin", "--auto")) | Out-Null
  }
  if (Test-Git ($G + @("symbolic-ref", "-q", "refs/remotes/origin/HEAD"))) {
    $o = Get-GitOutput ($G + @("symbolic-ref", "--short", "refs/remotes/origin/HEAD"))
    if ($o.Count) { $defaultBranch = ([string]$o[0]) -replace '^origin/', '' }
  }
  if (-not $defaultBranch) { $defaultBranch = "master" }
  if (-not $Base) { $Base = $defaultBranch }

  # В основную ветку — только явно и с подтверждением (пробный запуск ничего не отправляет).
  $isMain = ($Branch -eq $defaultBranch) -or ($Branch -eq "master") -or ($Branch -eq "main")
  if ($isMain -and -not $DryRun) {
    if (-not $branchGiven) { throw "Отправка в $Branch возможна только с явным -Branch $Branch." }
    Warn "изменения уйдут прямо в $Branch, минуя ветку для проверки."
    if ($Branch -eq "master") { Warn "сборка из master публикуется как общая ссылка android-latest — её скачивают все игроки." }
    $answer = Read-Host "Чтобы подтвердить, введите имя ветки ($Branch)"
    if ($answer -cne $Branch) { throw "Отменено: подтверждение не совпало, ничего не отправлено." }
  }

  # --- Ветка --------------------------------------------------------------
  $o = Get-GitOutput ($G + @("rev-parse", "--abbrev-ref", "HEAD"))
  if ($o.Count) { $startBranch = [string]$o[0] }
  $remoteHas = Test-Git ($G + @("rev-parse", "--verify", "--quiet", "refs/remotes/origin/$Branch"))
  $localHas = Test-Git ($G + @("rev-parse", "--verify", "--quiet", "refs/heads/$Branch"))
  if ($remoteHas) {
    if ($localHas) {
      Invoke-GitShow ($G + @("checkout", "-q", $Branch))
      if (-not (Test-Git ($G + @("merge", "--ff-only", "-q", "origin/$Branch")))) {
        throw "Локальная ветка $Branch в $clonePathFull разошлась с веткой на GitHub. Укажите другую ветку (-Branch) или разберитесь в клоне вручную."
      }
    } else {
      Invoke-GitShow ($G + @("checkout", "-q", "-b", $Branch, "--track", "origin/$Branch"))
      $createdBranch = $true
    }
    Say "Ветка $Branch уже есть на GitHub — новый коммит ляжет поверх неё"
  } elseif ($localHas) {
    Invoke-GitShow ($G + @("checkout", "-q", $Branch))
    Warn "ветка $Branch есть только в клоне (похоже, прошлая отправка не удалась) — продолжаю в ней."
  } else {
    if (-not (Test-Git ($G + @("rev-parse", "--verify", "--quiet", "refs/remotes/origin/$Base")))) {
      throw "На GitHub нет ветки $Base, от которой отводится новая. Укажите её: -Base <ветка>."
    }
    Invoke-GitShow ($G + @("checkout", "-q", "--no-track", "-b", $Branch, "origin/$Base"))
    $createdBranch = $true
    Say "Новая ветка $Branch от $Base"
  }

  # --- Перенос файлов ------------------------------------------------------
  Say "Переношу файлы из $Source"
  $touched = $true
  # 1) Удалённые в проекте: всё, что git хранит, но чего в проекте больше нет.
  #    Неотслеживаемые и игнорируемые файлы клона (node_modules, server\data и т. п.) не трогаем.
  $removed = 0
  foreach ($rel in (Get-GitOutput ($G + @("ls-files")))) {
    if (-not $rel -or (Test-Excluded $rel)) { continue }
    $winRel = $rel -replace '/', '\'
    if (-not (Test-Path -LiteralPath (Join-Path $Source $winRel) -PathType Leaf)) {
      $dst = Join-Path $clonePathFull $winRel
      if (Test-Path -LiteralPath $dst -PathType Leaf) { Remove-Item -LiteralPath $dst -Force; $removed++ }
    }
  }
  # 2) Новые и изменённые — robocopy без /MIR (он удалил бы и неотслеживаемые файлы клона).
  $rcArgs = @($Source, $clonePathFull, "/E", "/XJ", "/R:2", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/NS", "/NC", "/XD")
  $rcArgs += $ExcludeDirNames
  foreach ($d in $ExcludeRelDirs) { $rcArgs += (Join-Path $Source ($d -replace '/', '\')) }
  $rcArgs += "/XF"
  $rcArgs += $ExcludeFiles
  $rcOut = @(& robocopy @rcArgs)
  # Коды robocopy 0–7 — успех (что-то скопировано или нечего копировать), 8 и выше — ошибки.
  if ($LASTEXITCODE -ge 8) {
    $rcOut | Where-Object { $_ -and $_.Trim() } | Out-Host
    throw "robocopy не смог скопировать файлы (код $LASTEXITCODE)."
  }

  # 3) В индекс. Предупреждения о переводах строк (LF/CRLF) не показываем:
  #    .gitattributes проекта сам задаёт, как хранить .sh и .ps1.
  if (-not (Test-Git ($G + @("-c", "core.safecrlf=false", "add", "-A")))) {
    Invoke-GitShow ($G + @("-c", "core.safecrlf=false", "add", "-A"))
  }

  $status = Get-GitOutput ($G + @("status", "--porcelain", "--untracked-files=all"))
  # Неотправленные коммиты (например, прошлая отправка не удалась).
  $ahead = 0
  $aheadRef = "origin/$Base"
  if ($remoteHas) { $aheadRef = "origin/$Branch" }
  if (Test-Git ($G + @("rev-parse", "--verify", "--quiet", $aheadRef))) {
    $o = Get-GitOutput ($G + @("rev-list", "--count", "$aheadRef..HEAD"))
    if ($o.Count) { $ahead = [int]$o[0] }
  }
  if (-not $status.Count -and $ahead -eq 0) {
    Say "Отправлять нечего: на GitHub в $Branch уже то же самое, что в проекте."
    if ($createdBranch) { Restore-Clone }
    return
  }

  # --- Что изменилось -------------------------------------------------------
  if ($status.Count) {
    $added = @($status | Where-Object { $_ -match '^A' })
    $modified = @($status | Where-Object { $_ -match '^M' })
    $deleted = @($status | Where-Object { $_ -match '^D' })
    $renamed = @($status | Where-Object { $_ -match '^R' })
    Write-Host ""
    Write-Host ("Изменения: новых {0}, изменённых {1}, удалённых {2}, переименованных {3}." -f $added.Count, $modified.Count, $deleted.Count, $renamed.Count)
    $shown = @($status | Where-Object { $_ -notmatch '^D' } | Select-Object -First 80)
    foreach ($line in $shown) { Write-Host "  $line" }
    $rest = $status.Count - $deleted.Count - $shown.Count
    if ($rest -gt 0) { Write-Host "  … и ещё $rest (полный список: git -C `"$clonePathFull`" status)" }
    if ($deleted.Count) {
      Warn "в проекте нет этих файлов, поэтому они будут удалены и на GitHub (если это чужие свежие правки — отмените и сначала заберите их в проект):"
      foreach ($line in $deleted) { Write-Host "  $line" -ForegroundColor Yellow }
    }
    # Слишком большие файлы GitHub не примет — лучше узнать до коммита.
    foreach ($line in $status) {
      if ($line -match '^D') { continue }
      $p = $line.Substring(3)
      if ($p -match ' -> (.+)$') { $p = $Matches[1] }
      $p = $p.Trim('"')
      $full = Join-Path $clonePathFull ($p -replace '/', '\')
      if ((Test-Path -LiteralPath $full -PathType Leaf) -and (Get-Item -LiteralPath $full).Length -gt $MaxFileBytes) {
        throw "Файл $p больше 95 МБ — GitHub его не примет. Уберите его из проекта или добавьте в исключения в начале скрипта."
      }
    }
  }
  if ($ahead -gt 0) { Write-Host ("Неотправленных коммитов в ветке: {0}." -f $ahead) }
  Write-Host ""

  if ($DryRun) {
    Say "Пробный запуск: ничего не закоммичено и не отправлено. Клон возвращён в прежнее состояние."
    Restore-Clone
    return
  }

  if ($status.Count) {
    $email = ""
    $o = @()
    if (Test-Git ($G + @("config", "user.email"))) { $o = Get-GitOutput ($G + @("config", "user.email")) }
    if ($o.Count) { $email = [string]$o[0] }
    if (-not $email) {
      throw "В git не указаны имя и email автора коммитов. Выполните один раз:`n  git config --global user.name `"Ваше имя`"`n  git config --global user.email `"you@example.ru`"`nи запустите скрипт снова."
    }
  }

  if (-not $Yes) {
    $answer = Read-Host ("Закоммитить и отправить в ветку {0} репозитория {1}? (да/нет)" -f $Branch, $info.Url)
    if ($answer -notmatch '^\s*(y|yes|д|да)\s*$') {
      Restore-Clone
      Say "Отменено: ничего не отправлено."
      return
    }
  }

  # --- Коммит и отправка ---------------------------------------------------
  if ($status.Count) {
    # Текст коммита — через файл в UTF-8: так кириллица не зависит от кодировки консоли.
    $msgFile = Join-Path $env:TEMP ("tm-push-msg-{0}.txt" -f [guid]::NewGuid().ToString("N"))
    [System.IO.File]::WriteAllText($msgFile, $Message, (New-Object System.Text.UTF8Encoding $false))
    try { Invoke-GitShow ($G + @("commit", "-q", "-F", $msgFile)) } finally { Remove-Item -LiteralPath $msgFile -Force -ErrorAction SilentlyContinue }
    $committed = $true
    Say "Коммит готов"
  }

  Say "Отправляю ветку $Branch (ваши учётные данные git)"
  try {
    Invoke-GitShow ($G + @("push", "-u", "origin", "refs/heads/${Branch}:refs/heads/${Branch}"))
  } catch {
    Warn "GitHub не принял отправку. Если в ответе «rejected» / «fetch first» — в ветке на GitHub есть коммиты, которых нет в клоне: запустите скрипт ещё раз (он их подтянет) или укажите другую ветку -Branch. Если ошибка входа — проверьте доступ к репозиторию (git credential manager / SSH-ключ). Коммит остался в $clonePathFull."
    throw
  }

  # --- Где APK ------------------------------------------------------------------
  Write-Host ""
  Say "Готово: ветка $Branch на GitHub"
  if ($info.Web) {
    $web = $info.Web
    $tag = Get-ReleaseTag $Branch
    $q = [Uri]::EscapeDataString("branch:$Branch")
    Write-Host ("Ветка:          {0}/tree/{1}" -f $web, $Branch)
    Write-Host ("Сборка APK:     {0}/actions/workflows/android.yml?query={1}" -f $web, $q)
    Write-Host  "                (запуск «Android APK» по этой ветке, 10–20 минут)"
    Write-Host ("Готовый APK:    {0}/releases/tag/{1}" -f $web, $tag)
    Write-Host ("Прямая ссылка:  {0}/releases/download/{1}/trade-monopoly.apk" -f $web, $tag)
    if ($Branch -ne "master") {
      Write-Host  "                (pre-release ветки; появится, когда сборка станет зелёной)"
      Write-Host ("Pull request:   {0}/compare/{1}...{2}?expand=1" -f $web, $Base, $Branch)
    }
    Write-Host ""
    Write-Host "Сборка запускается сама, если в коммите есть изменения в server/public, mobile или"
    Write-Host "в .github/workflows/android.yml. Иначе — вручную: Actions → Android APK → Run workflow"
    Write-Host "→ Use workflow from: $Branch."
    Write-Host "Сборки для RuStore и Google Play — тем же Run workflow с полем «Сборка» = rustore или"
    Write-Host "googleplay; результат — в Artifacts запуска (в Releases не публикуется). Подробно — GITHUB.md."
  }
  if ($ownClone) { Write-Host ""; Write-Host "Рабочий клон: $clonePathFull (используется при следующем запуске, можно удалить)." }
} catch {
  # Ошибка до коммита — возвращаем клон как был (после коммита оставляем: его ещё можно отправить).
  if ($clone -and -not $committed) { try { Restore-Clone } catch {} }
  Write-Host ""
  Write-Host ("Ошибка: {0}" -f $_.Exception.Message) -ForegroundColor Red
  exit 1
} finally {
  if ($null -ne $prevOutputEncoding) { try { [Console]::OutputEncoding = $prevOutputEncoding } catch {} }
}
