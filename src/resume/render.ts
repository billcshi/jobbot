/**
 * Resume rendering — LaTeX → PDF.
 *
 * Future: takes tailored resume data, injects it into templates/master.tex
 * (or a tailored copy), and compiles via pdflatex.
 *
 * Requires: texlive-latex-base texlive-latex-recommended
 *
 * Usage (planned):
 *   pnpm jobbot render --job 123
 *
 * For v0 this is not yet implemented.
 */
export function renderResume(_versionId: number): void {
  throw new Error('renderResume not yet implemented');
}
