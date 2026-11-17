#!/usr/bin/env bash
# Harnes-Installer für Linux und macOS
#   curl -fsSL https://github.com/davidhbg/harnes/releases/latest/download/install.sh | bash
set -u

# Zeichen statt Bytes zählen (Logo und Verlauf brauchen eine UTF-8-Umgebung)
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *UTF-8* | *utf8* | *UTF8*) ;;
  *) if [ "$(uname -s)" = "Darwin" ]; then export LC_ALL=en_US.UTF-8; else export LC_ALL=C.UTF-8; fi ;;
esac

PAKET="${HARNES_PAKET:-https://github.com/davidhbg/harnes/releases/latest/download/harnes.tgz}"
PAD='   '

# ---------- Farben ----------
if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ]; then VT=1; else VT=0; fi
R=$'\e[0m'; DIM=$'\e[38;2;154;147;184m'; OK=$'\e[38;2;111;207;151m'; BAD=$'\e[38;2;235;111;146m'; TXT=$'\e[38;2;239;234;255m'; BOLD=$'\e[1m'
[ "$VT" = 1 ] || { R=''; DIM=''; OK=''; BAD=''; TXT=''; BOLD=''; }

# Verlauf Pfirsich -> Flieder -> Violett, t in Tausendstel
grad() {
  local t=$1 a b u
  if [ "$t" -lt 500 ]; then a=(240 185 141); b=(196 167 231); u=$((t * 2)); else a=(196 167 231); b=(139 124 246); u=$(((t - 500) * 2)); fi
  printf '\e[38;2;%d;%d;%dm' $((a[0] + (b[0] - a[0]) * u / 1000)) $((a[1] + (b[1] - a[1]) * u / 1000)) $((a[2] + (b[2] - a[2]) * u / 1000))
}
# Zeile mit Farbverlauf (zeichenweise, auch für mehrbytige Zeichen)
gradline() {
  local s=$1 n i out=''
  if [ "$VT" != 1 ]; then printf '%s' "$s"; return; fi
  n=${#s}
  for ((i = 0; i < n; i++)); do out+="$(grad $((i * 1000 / (n > 1 ? n - 1 : 1))))${s:i:1}"; done
  printf '%s%s' "$out" "$R"
}
line() { printf '%s%s%s%s %s%s%s\n' "$PAD" "$2" "$1" "$R" "$TXT" "$3" "$R"; }
fail() {
  line '✗' "$BAD" "$1"; shift
  for m in "$@"; do printf '%s  %s%s%s\n' "$PAD" "$DIM" "$m" "$R"; done
  [ "$VT" = 1 ] && printf '\e[?25h'
  echo; exit 1
}

LOGO=(
'██╗  ██╗ █████╗ ██████╗ ███╗   ██╗███████╗███████╗'
'██║  ██║██╔══██╗██╔══██╗████╗  ██║██╔════╝██╔════╝'
'███████║███████║██████╔╝██╔██╗ ██║█████╗  ███████╗'
'██╔══██║██╔══██║██╔══██╗██║╚██╗██║██╔══╝  ╚════██║'
'██║  ██║██║  ██║██║  ██║██║ ╚████║███████╗███████║'
'╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝'
)

# ---------- Logo einblenden ----------
echo
if [ "$VT" = 1 ]; then
  printf '\e[?25l'
  w=${#LOGO[0]}
  for f in $(seq 0 14); do
    show=$((w * f / 14))
    for l in "${LOGO[@]}"; do printf '%s%s\e[K\n' "$PAD" "$(gradline "${l:0:show}")"; done
    [ "$f" -lt 14 ] && printf '\e[%dA' "${#LOGO[@]}"
    sleep 0.03
  done
else
  for l in "${LOGO[@]}"; do echo "$PAD$l"; done
fi
echo
printf '%s%s    %sDein KI-Team im Terminal%s\n\n' "$PAD" "$(gradline 'K  I  -  T  E  A  M')" "$DIM" "$R"

# ---------- Voraussetzungen ----------
command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || fail 'Node.js fehlt' \
  'Harnes braucht Node.js ab Version 22, z. B. mit nvm:' \
  '  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash' \
  '  source ~/.bashrc && nvm install 22' 'Danach diesen Befehl noch einmal ausführen.'
VER=$(node -v)
MAJOR=${VER#v}; MAJOR=${MAJOR%%.*}
[ "$MAJOR" -ge 22 ] 2>/dev/null || fail "Node.js $VER ist zu alt" 'Harnes braucht Node.js ab Version 22 (z. B. nvm install 22).'
line '✓' "$OK" "Node.js $VER gefunden"

if [ "$(uname -s)" = "Linux" ]; then
  # node-pty wird unter Linux beim Installieren gebaut
  if ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then H='sudo apt update && sudo apt install -y build-essential python3'
    elif command -v dnf >/dev/null 2>&1; then H='sudo dnf install -y gcc-c++ make python3'
    elif command -v pacman >/dev/null 2>&1; then H='sudo pacman -S --needed base-devel python'
    else H='Compiler (g++), make und python3 installieren'; fi
    fail 'Bauwerkzeuge fehlen' 'Harnes braucht einmalig g++, make und python3:' "  $H" 'Danach diesen Befehl noch einmal ausführen.'
  fi
  line '✓' "$OK" 'Bauwerkzeuge vorhanden'
fi

PREFIX=$(npm prefix -g)
if [ ! -w "$PREFIX/lib" ] && [ ! -w "$PREFIX" ]; then
  fail "Keine Schreibrechte für $PREFIX" 'Am einfachsten Node.js mit nvm installieren (ohne sudo), siehe README.' 'Oder: sudo npm install -g '"$PAKET"
fi

# ---------- Installieren mit Animation ----------
LOG=$(mktemp)
npm install -g "$PAKET" --no-fund --no-audit --loglevel=error >"$LOG" 2>&1 &
PID=$!
TEXTE=('Hole Harnes von GitHub' 'Packe das Team aus' 'Richte das Terminal ein' 'Verbinde die Bausteine' 'Poliere die Sterne' 'Fast geschafft' 'Fast geschafft')
SPIN=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
START=$(date +%s); F=0; BW=28
while kill -0 "$PID" 2>/dev/null; do
  SEC=$(($(date +%s) - START))
  IDX=$((SEC / 4)); [ "$IDX" -gt 6 ] && IDX=6
  if [ "$VT" = 1 ]; then
    BAR=''; HEAD=$(((F * 8 / 10) % (BW + 10) - 5))
    for ((i = 0; i < BW; i++)); do
      d=$((i - HEAD)); d=${d#-}
      if [ "$d" -lt 5 ]; then BAR+="$(grad $((i * 1000 / (BW - 1))))━"; else BAR+=$'\e[38;2;60;54;84m━'; fi
    done
    printf '\r\e[2K%s%s%s%s %s%s  %s%s%s %s%s s%s' "$PAD" "$(grad $(((F % 20) * 50)))" "${SPIN[F % 10]}" "$R" "$BAR" "$R" "$TXT" "${TEXTE[IDX]}" "$R" "$DIM" "$SEC" "$R"
  else
    printf '\r%s%s  %s ... %s s   ' "$PAD" "${SPIN[F % 10]}" "${TEXTE[IDX]}" "$SEC"
  fi
  sleep 0.08; F=$((F + 1))
done
wait "$PID"; CODE=$?
SEC=$(($(date +%s) - START))
printf '\r\e[2K'
if [ "$CODE" -ne 0 ]; then
  ERR=()
  while IFS= read -r z; do ERR+=("$z"); done < <(grep -v '^[[:space:]]*$' "$LOG" | tail -n 8)
  rm -f "$LOG"
  fail "Installation fehlgeschlagen (npm meldet Fehler $CODE)" "${ERR[@]}"
fi
rm -f "$LOG"

# ---------- Fertig ----------
HV=$("$PREFIX/bin/harnes" --version 2>/dev/null || harnes --version 2>/dev/null || true)
line '✓' "$OK" "Harnes $HV installiert ($SEC s)"
echo
IN=44; H=$(printf '─%.0s' $(seq 1 $IN))
box() { local a=$1 b=$2; printf '%s%s│%s%s%s%s%s%*s%s│%s\n' "$PAD" "$(grad 300)" "$R" "$TXT" "$a" "$R" "$BOLD$(gradline "$b")" $((IN - ${#a} - ${#b})) '' "$(grad 700)" "$R"; }
printf '%s%s╭%s╮%s\n' "$PAD" "$(grad 0)" "$H" "$R"
box '' ''
box "  ✦  Los geht's:   " 'harnes'
box '' ''
box '  Die Einrichtung führt dich durch alles.' ''
box '  Hilfe im Programm: /hilfe' ''
box '' ''
printf '%s%s╰%s╯%s\n' "$PAD" "$(grad 1000)" "$H" "$R"
case ":$PATH:" in *":$PREFIX/bin:"*) ;; *) echo; line '·' "$DIM" 'Falls harnes nicht gefunden wird: ein neues Terminal öffnen.' ;; esac
[ "$VT" = 1 ] && printf '\e[?25h'
echo
