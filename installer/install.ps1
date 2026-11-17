# Harnes-Installer fuer Windows
#   irm https://github.com/davidhbg/harnes/releases/latest/download/install.ps1 | iex
# Diese Datei enthaelt mit Absicht nur ASCII-Zeichen (kommt so in jeder PowerShell unverfaelscht an);
# Logo, Umlaute und Symbole werden erst beim Ausfuehren zusammengesetzt.

& {
  $ErrorActionPreference = 'Stop'
  $paket = if ($env:HARNES_PAKET) { $env:HARNES_PAKET } else { 'https://github.com/davidhbg/harnes/releases/latest/download/harnes.tgz' }

  # ---------- Zeichen und Farben ----------
  function U([string]$s) {
    # {ae} {oe} {ue} {ss} {Ae} {Oe} {Ue} -> Umlaute
    $s.Replace('{ae}', [string][char]0xE4).Replace('{oe}', [string][char]0xF6).Replace('{ue}', [string][char]0xFC).Replace('{ss}', [string][char]0xDF).Replace('{Ae}', [string][char]0xC4).Replace('{Oe}', [string][char]0xD6).Replace('{Ue}', [string][char]0xDC)
  }
  $E = [char]27
  $vt = $false
  try { $vt = [bool]$Host.UI.SupportsVirtualTerminal } catch { }
  if ($env:WT_SESSION) { $vt = $true }
  try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
  $check = [string][char]0x2713
  $cross = [string][char]0x2717
  $star = [string][char]0x2726
  $dot = [string][char]0x00B7
  $spin = @(0x280B, 0x2819, 0x2839, 0x2838, 0x283C, 0x2834, 0x2826, 0x2827, 0x2807, 0x280F) | ForEach-Object { [string][char]$_ }
  $bar = [string][char]0x2501
  $logo = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('4paI4paI4pWXICDilojilojilZcg4paI4paI4paI4paI4paI4pWXIOKWiOKWiOKWiOKWiOKWiOKWiOKVlyDilojilojilojilZcgICDilojilojilZfilojilojilojilojilojilojilojilZfilojilojilojilojilojilojilojilZcK4paI4paI4pWRICDilojilojilZHilojilojilZTilZDilZDilojilojilZfilojilojilZTilZDilZDilojilojilZfilojilojilojilojilZcgIOKWiOKWiOKVkeKWiOKWiOKVlOKVkOKVkOKVkOKVkOKVneKWiOKWiOKVlOKVkOKVkOKVkOKVkOKVnQrilojilojilojilojilojilojilojilZHilojilojilojilojilojilojilojilZHilojilojilojilojilojilojilZTilZ3ilojilojilZTilojilojilZcg4paI4paI4pWR4paI4paI4paI4paI4paI4pWXICDilojilojilojilojilojilojilojilZcK4paI4paI4pWU4pWQ4pWQ4paI4paI4pWR4paI4paI4pWU4pWQ4pWQ4paI4paI4pWR4paI4paI4pWU4pWQ4pWQ4paI4paI4pWX4paI4paI4pWR4pWa4paI4paI4pWX4paI4paI4pWR4paI4paI4pWU4pWQ4pWQ4pWdICDilZrilZDilZDilZDilZDilojilojilZEK4paI4paI4pWRICDilojilojilZHilojilojilZEgIOKWiOKWiOKVkeKWiOKWiOKVkSAg4paI4paI4pWR4paI4paI4pWRIOKVmuKWiOKWiOKWiOKWiOKVkeKWiOKWiOKWiOKWiOKWiOKWiOKWiOKVl+KWiOKWiOKWiOKWiOKWiOKWiOKWiOKVkQrilZrilZDilZ0gIOKVmuKVkOKVneKVmuKVkOKVnSAg4pWa4pWQ4pWd4pWa4pWQ4pWdICDilZrilZDilZ3ilZrilZDilZ0gIOKVmuKVkOKVkOKVkOKVneKVmuKVkOKVkOKVkOKVkOKVkOKVkOKVneKVmuKVkOKVkOKVkOKVkOKVkOKVkOKVnQ==')) -split "`n"

  # Verlauf: Pfirsich -> Flieder -> Violett
  $stops = @(@(240, 185, 141), @(196, 167, 231), @(139, 124, 246))
  function Grad([double]$t) {
    $t = [Math]::Max([double]0, [Math]::Min([double]1, [double]$t))
    if ($t -lt 0.5) { $a = $stops[0]; $b = $stops[1]; $u = $t * 2 } else { $a = $stops[1]; $b = $stops[2]; $u = ($t - 0.5) * 2 }
    @([int]($a[0] + ($b[0] - $a[0]) * $u), [int]($a[1] + ($b[1] - $a[1]) * $u), [int]($a[2] + ($b[2] - $a[2]) * $u))
  }
  function Fg($rgb) { "$E[38;2;$($rgb[0]);$($rgb[1]);$($rgb[2])m" }
  $cReset = "$E[0m"; $cDim = "$E[38;2;154;147;184m"; $cOk = "$E[38;2;111;207;151m"; $cBad = "$E[38;2;235;111;146m"; $cTxt = "$E[38;2;239;234;255m"; $cBold = "$E[1m"

  # Eine Zeile mit Farbverlauf; shine = Position eines hellen Glanzstreifens (in Zeichen)
  function GradLine([string]$s, [double]$shine = -100) {
    if (-not $vt) { return $s }
    $out = New-Object Text.StringBuilder
    for ($i = 0; $i -lt $s.Length; $i++) {
      $c = Grad ($i / [Math]::Max(1, $s.Length - 1))
      $d = [Math]::Abs($i - $shine)
      if ($d -lt 4) { $k = (4 - $d) / 4 * 0.7; $c = @([int]($c[0] + (255 - $c[0]) * $k), [int]($c[1] + (255 - $c[1]) * $k), [int]($c[2] + (255 - $c[2]) * $k)) }
      [void]$out.Append((Fg $c)).Append($s[$i])
    }
    [void]$out.Append($cReset)
    $out.ToString()
  }
  function Say([string]$s) { Write-Host (U $s) }

  # ---------- Logo einblenden ----------
  Write-Host ''
  $pad = '   '
  if ($vt) {
    [Console]::Write("$E[?25l")
    $w = $logo[0].Length
    for ($f = 0; $f -le 22; $f++) {
      $show = [int]($w * $f / 14)
      $shine = ($f - 6) * ($w / 12.0)
      foreach ($l in $logo) {
        $part = if ($show -ge $l.Length) { $l } else { $l.Substring(0, [Math]::Max(0, $show)) }
        [Console]::Write("$pad$(GradLine $part $shine)$E[K`n")
      }
      if ($f -lt 22) { [Console]::Write("$E[$($logo.Count)A") }
      Start-Sleep -Milliseconds 35
    }
  } else {
    foreach ($l in $logo) { Write-Host "$pad$l" -ForegroundColor Magenta }
  }
  Write-Host ''
  if ($vt) { Write-Host "$pad$(GradLine 'K  I  -  T  E  A  M')    $cDim$(U 'Dein KI-Team im Terminal')$cReset" } else { Write-Host "$pad K I - T E A M    Dein KI-Team im Terminal" -ForegroundColor DarkMagenta }
  Write-Host ''

  function Line([string]$sym, [string]$col, [string]$text) {
    if ($vt) { Write-Host "$pad$col$sym$cReset $cTxt$(U $text)$cReset" } else { Write-Host "$pad$sym $(U $text)" }
  }
  function Fail([string]$text, [string[]]$more) {
    Line $cross $cBad $text
    foreach ($m in $more) { if ($vt) { Write-Host "$pad  $cDim$(U $m)$cReset" } else { Write-Host "$pad  $(U $m)" } }
    if ($vt) { [Console]::Write("$E[?25h") }
    Write-Host ''
  }

  # ---------- Voraussetzungen ----------
  $node = Get-Command node -ErrorAction SilentlyContinue
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $node -or -not $npm) {
    Fail 'Node.js fehlt' @('Harnes braucht Node.js ab Version 22. Am einfachsten:', '  winget install OpenJS.NodeJS.LTS', 'Danach ein neues Terminal {oe}ffnen und den Befehl noch einmal ausf{ue}hren.')
    return
  }
  $ver = (& node -v).Trim()
  $major = [int]($ver.TrimStart('v').Split('.')[0])
  if ($major -lt 22) {
    Fail "Node.js $ver ist zu alt" @('Harnes braucht Node.js ab Version 22:', '  winget upgrade OpenJS.NodeJS.LTS')
    return
  }
  Line $check $cOk "Node.js $ver gefunden"

  # ---------- Installieren mit Animation ----------
  $log = Join-Path $env:TEMP ('harnes-install-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $p = Start-Process -FilePath $npm.Source -ArgumentList @('install', '-g', "`"$paket`"", '--no-fund', '--no-audit', '--loglevel=error') -NoNewWindow -PassThru -RedirectStandardOutput "$log.out" -RedirectStandardError "$log.err"
  $null = $p.Handle  # sonst liefert Windows den Rueckgabewert nicht
  $texte = @('Hole Harnes von GitHub', 'Packe das Team aus', 'Richte das Terminal ein', 'Verbinde die Bausteine', 'Lege den Begleiter bereit', 'Poliere die Sterne', 'Fast geschafft')
  $t0 = Get-Date
  $frame = 0
  $bw = 28
  while (-not $p.HasExited) {
    $sec = ((Get-Date) - $t0).TotalSeconds
    $label = U $texte[[Math]::Min($texte.Count - 1, [int][Math]::Floor($sec / 4))]
    $s = $spin[$frame % $spin.Count]
    if ($vt) {
      $sb = New-Object Text.StringBuilder
      $head = ($frame * 0.8) % ($bw + 10) - 5
      for ($i = 0; $i -lt $bw; $i++) {
        $c = Grad ($i / ($bw - 1))
        $d = [Math]::Abs($i - $head)
        $k = if ($d -lt 5) { 1 - $d / 5 } else { 0.18 }
        $c = @([int]($c[0] * $k + 30 * (1 - $k)), [int]($c[1] * $k + 26 * (1 - $k)), [int]($c[2] * $k + 46 * (1 - $k)))
        [void]$sb.Append((Fg $c)).Append($bar)
      }
      [Console]::Write("`r$E[2K$pad$(Fg (Grad (($frame % 20) / 19.0)))$s$cReset $($sb.ToString())$cReset  $cTxt$label$cReset $cDim$([int]$sec) s$cReset")
    } else {
      [Console]::Write("`r$pad$s  $label ... $([int]$sec) s     ")
    }
    Start-Sleep -Milliseconds 80
    $frame++
  }
  $p.WaitForExit()
  $sec = [int]((Get-Date) - $t0).TotalSeconds
  if ($vt) { [Console]::Write("`r$E[2K") } else { [Console]::Write("`r" + (' ' * 70) + "`r") }

  if ($p.ExitCode -ne 0 -or -not (Test-Path (Join-Path ((& $npm.Source prefix -g).Trim()) 'harnes.cmd'))) {
    $err = @()
    if (Test-Path "$log.err") { $err = Get-Content "$log.err" | Where-Object { $_ -match '\S' } | Select-Object -Last 8 }
    Fail "Installation fehlgeschlagen (npm meldet Fehler $($p.ExitCode))" ($err + @('', 'Kommt EBUSY: alle Harnes-Fenster schlie{ss}en und noch einmal versuchen.'))
    Remove-Item "$log.out", "$log.err" -ErrorAction SilentlyContinue
    return
  }
  Remove-Item "$log.out", "$log.err" -ErrorAction SilentlyContinue

  # ---------- Fertig ----------
  $prefix = (& $npm.Source prefix -g).Trim()
  $hv = ''
  try { $hv = (& (Join-Path $prefix 'harnes.cmd') --version).Trim() } catch { }
  Line $check $cOk "Harnes $hv installiert ($sec s)"
  Write-Host ''
  $tl = [string][char]0x256D; $tr = [string][char]0x256E; $bl = [string][char]0x2570; $br = [string][char]0x256F; $h = [string][char]0x2500; $v = [string][char]0x2502
  $inner = 44
  $rows = @(
    @('', ''),
    @("  $star  Los geht's:   ", 'harnes'),
    @('', ''),
    @('  Die Einrichtung f{ue}hrt dich durch alles.', ''),
    @('  Hilfe im Programm: /hilfe', ''),
    @('', '')
  )
  if ($vt) {
    Write-Host "$pad$(Fg (Grad 0))$tl$($h * $inner)$tr$cReset"
    foreach ($row in $rows) {
      $left = U $row[0]; $word = $row[1]
      $fill = ' ' * [Math]::Max(0, $inner - $left.Length - $word.Length)
      Write-Host "$pad$(Fg (Grad 0.3))$v$cReset$cTxt$left$cReset$cBold$(GradLine $word)$cReset$fill$(Fg (Grad 0.7))$v$cReset"
    }
    Write-Host "$pad$(Fg (Grad 1))$bl$($h * $inner)$br$cReset"
    [Console]::Write("$E[?25h")
  } else {
    Write-Host "$pad  Los geht's:  harnes" -ForegroundColor Magenta
    Write-Host "$pad  $(U 'Die Einrichtung f{ue}hrt dich durch alles.')"
  }
  if (-not (($env:Path -split ';') -contains $prefix)) {
    Write-Host ''
    Line $dot $cDim 'Falls harnes nicht gefunden wird: ein neues Terminal {oe}ffnen.'
  }
  Write-Host ''
}
