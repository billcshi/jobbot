#!/usr/bin/env bash
# JobBot - One-Command Setup
# Run this once after cloning the repo.
#
# Usage:
#   bash scripts/setup.sh
#
# What it does:
#   1. Installs LaTeX (texlive) for resume/cover-letter PDF generation
#   2. Installs Poppler for PDF verification
#   3. Installs Node.js dependencies via pnpm
#   4. Creates and initializes the local SQLite database
#   5. Runs post-install verification

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'
PNPM_VERSION='10.15.1'
REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PNPM_CMD=()

cd "$REPOSITORY_ROOT"

echo -e "${BOLD}=== JobBot Setup ===${NC}"
echo ""

# ---- Check prerequisites ---------------------------------------------------
echo -e "${BOLD}[1/5] Checking prerequisites...${NC}"

if ! command -v node &>/dev/null; then
  echo -e "${RED}Node.js is not installed. Install Node.js >= 20 first.${NC}"
  echo "  https://nodejs.org/  or  nvm install 20"
  exit 1
fi
echo "  Node.js $(node --version)"

NODE_MAJOR="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo -e "${RED}Node.js >= 20 is required.${NC}"
  exit 1
fi

CURRENT_PNPM_VERSION="$(pnpm --version 2>/dev/null || true)"
if [ "$CURRENT_PNPM_VERSION" = "$PNPM_VERSION" ]; then
  PNPM_CMD=(pnpm)
elif command -v corepack &>/dev/null; then
  PNPM_CMD=(corepack pnpm)
else
  echo -e "${RED}pnpm $PNPM_VERSION is required and Corepack is unavailable.${NC}"
  echo "  Install pnpm from https://pnpm.io/installation and rerun setup."
  exit 1
fi

ACTIVE_PNPM_VERSION="$("${PNPM_CMD[@]}" --version 2>/dev/null || true)"
if [ "$ACTIVE_PNPM_VERSION" != "$PNPM_VERSION" ]; then
  echo -e "${RED}pnpm $PNPM_VERSION is required; found ${ACTIVE_PNPM_VERSION:-nothing}.${NC}"
  exit 1
fi
echo "  pnpm $ACTIVE_PNPM_VERSION (via ${PNPM_CMD[*]})"

# ---- System dependencies (LaTeX + Poppler) ---------------------------------
echo ""
echo -e "${BOLD}[2/5] Installing system dependencies...${NC}"
echo "  This may take a few minutes on first install."

PACKAGES_TO_INSTALL=""

latex_template_packages_available() {
  command -v pdflatex &>/dev/null || return 1
  command -v kpsewhich &>/dev/null || return 1
  local package
  for package in titlesec.sty marvosym.sty enumitem.sty hyperref.sty fancyhdr.sty tabularx.sty lato.sty fontawesome5.sty; do
    kpsewhich "$package" | grep -q . || return 1
  done
}

# Check pdflatex and every package used by resumes/master.tex.
if latex_template_packages_available; then
  echo "  pdflatex already installed ($(pdflatex --version | head -1))"
else
  PACKAGES_TO_INSTALL="$PACKAGES_TO_INSTALL texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended texlive-fonts-extra"
fi

# Check Poppler commands used by content and visual audits
if command -v pdftoppm &>/dev/null && command -v pdfinfo &>/dev/null && command -v pdftotext &>/dev/null; then
  echo "  Poppler already installed ($(pdftoppm -v 2>&1 | head -1))"
else
  PACKAGES_TO_INSTALL="$PACKAGES_TO_INSTALL poppler-utils"
fi

if [ -n "$PACKAGES_TO_INSTALL" ]; then
  if ! command -v apt-get &>/dev/null; then
    echo -e "${RED}Automatic system-package installation currently supports Debian/Ubuntu (apt-get).${NC}"
    echo "  Install LaTeX and Poppler manually, then rerun setup."
    exit 1
  fi
  APT_PREFIX=()
  if [ "$(id -u)" -ne 0 ]; then
    if ! command -v sudo &>/dev/null; then
      echo -e "${RED}Installing system packages requires root access or sudo.${NC}"
      exit 1
    fi
    APT_PREFIX=(sudo)
  fi
  "${APT_PREFIX[@]}" apt-get update -qq
  # shellcheck disable=SC2086
  "${APT_PREFIX[@]}" apt-get install -y $PACKAGES_TO_INSTALL
  echo -e "  ${GREEN}System packages installed${NC}"
fi

# ---- Node.js dependencies --------------------------------------------------
echo ""
echo -e "${BOLD}[3/5] Installing Node.js dependencies...${NC}"
"${PNPM_CMD[@]}" install --frozen-lockfile
echo -e "  ${GREEN}Dependencies installed${NC}"

# ---- Initialize JobBot -----------------------------------------------------
echo ""
echo -e "${BOLD}[4/5] Initializing JobBot...${NC}"
"${PNPM_CMD[@]}" jobbot init-db
echo -e "  ${GREEN}local/ created, database initialized${NC}"

# ---- Verify installation --------------------------------------------------
echo ""
echo -e "${BOLD}[5/5] Verifying installation...${NC}"
for command_name in pdflatex pdftoppm pdfinfo pdftotext; do
  if ! command -v "$command_name" &>/dev/null; then
    echo -e "${RED}$command_name is not available after installation.${NC}"
    exit 1
  fi
done

# Compile the same package set used by resumes/master.tex. A command existing on
# PATH is not enough: minimal TeX installations can still be missing template
# packages such as fontawesome5, lato, fancyhdr, or titlesec.
LATEX_SMOKE_DIR="$(mktemp -d)"
cleanup_latex_smoke() {
  rm -rf -- "$LATEX_SMOKE_DIR"
}
trap cleanup_latex_smoke EXIT
cat > "$LATEX_SMOKE_DIR/smoke.tex" <<'TEX'
\documentclass[letterpaper,11pt]{article}
\usepackage{latexsym}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage{marvosym}
\usepackage[usenames,dvipsnames]{color}
\usepackage{verbatim}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\usepackage{fancyhdr}
\usepackage[english]{babel}
\usepackage{tabularx}
\usepackage[default]{lato}
\usepackage{fontawesome5}
\begin{document}
\textbf{JobBot LaTeX smoke test}
\end{document}
TEX
pdflatex -interaction=nonstopmode -halt-on-error \
  -output-directory="$LATEX_SMOKE_DIR" "$LATEX_SMOKE_DIR/smoke.tex" >/dev/null
test -f "$LATEX_SMOKE_DIR/smoke.pdf"
cleanup_latex_smoke
trap - EXIT
echo -e "  ${GREEN}JobBot LaTeX template dependency smoke test passed${NC}"

"${PNPM_CMD[@]}" typecheck
"${PNPM_CMD[@]}" test
echo -e "  ${GREEN}LaTeX, Poppler, types, and tests verified${NC}"

# ---- Done ------------------------------------------------------------------
echo ""
echo -e "${BOLD}=== Setup complete ===${NC}"
echo ""
echo "  Next steps:"
echo "    1. Start the UI:  ${PNPM_CMD[*]} jobbot ui"
echo "    2. Open:          http://localhost:3000"
echo "    3. Ask your AI coding agent to interview you and create your profile."
echo ""
