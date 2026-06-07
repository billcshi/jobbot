#!/usr/bin/env bash
# JobBot — One-Command Setup
# Run this once after cloning the repo.
#
# Usage:
#   bash scripts/setup.sh
#
# What it does:
#   1. Installs LaTeX (texlive) for resume/cover-letter PDF generation
#   2. Installs Node.js dependencies via pnpm
#   3. Creates local/ directory from local.example/ template
#   4. Initializes the SQLite database

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}=== JobBot Setup ===${NC}"
echo ""

# ---- Check prerequisites ---------------------------------------------------
echo -e "${BOLD}[1/4] Checking prerequisites...${NC}"

if ! command -v node &>/dev/null; then
  echo -e "${RED}Node.js is not installed. Install Node.js >= 20 first.${NC}"
  echo "  https://nodejs.org/  or  nvm install 20"
  exit 1
fi
echo "  Node.js $(node --version)"

if ! command -v pnpm &>/dev/null; then
  echo -e "${RED}pnpm is not installed.${NC}"
  echo "  npm install -g pnpm  or  corepack enable pnpm"
  exit 1
fi
echo "  pnpm $(pnpm --version)"

# ---- System dependencies (LaTeX) -------------------------------------------
echo ""
echo -e "${BOLD}[2/4] Installing LaTeX...${NC}"
echo "  This may take a few minutes on first install."

# Check if pdflatex is already installed
if command -v pdflatex &>/dev/null; then
  echo "  pdflatex already installed ($(pdflatex --version | head -1))"
else
  sudo apt-get update -qq
  sudo apt-get install -y \
    texlive-latex-base \
    texlive-latex-recommended \
    texlive-latex-extra \
    texlive-fonts-recommended \
    texlive-fonts-extra
  echo -e "  ${GREEN}pdflatex installed${NC}"
fi

# ---- Node.js dependencies --------------------------------------------------
echo ""
echo -e "${BOLD}[3/4] Installing Node.js dependencies...${NC}"
pnpm install
echo -e "  ${GREEN}Dependencies installed${NC}"

# ---- Initialize JobBot -----------------------------------------------------
echo ""
echo -e "${BOLD}[4/4] Initializing JobBot...${NC}"
pnpm jobbot init-db
echo -e "  ${GREEN}local/ created, database initialized${NC}"

# ---- Done ------------------------------------------------------------------
echo ""
echo -e "${BOLD}=== Setup complete ===${NC}"
echo ""
echo "  Next steps:"
echo "    1. Review the template:  cat local/profile/candidate.yaml"
echo "    2. Open Claude Code:     claude"
echo "    3. Tell Claude about yourself — it will fill in your profile"
echo "    4. Test LaTeX:           pdflatex -output-directory local/resumes/output local/resumes/resume-general.tex"
echo ""
