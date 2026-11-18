/**
 * What arXiv's TeX Live can read, from arXiv's own help pages. Update this table when
 * arXiv adds a TeX Live year (see `checkedOn`); `arxiv-bbl-version` compares a shipped
 * biblatex .bbl against it.
 */
export interface ArxivTexLive {
  year: number;
  biblatex: string;
  biber: string;
  /** biblatex .bbl format versions this TeX Live reads. */
  bblFormats: string[];
}

export const ARXIV_TEXLIVE = {
  source: [
    'https://info.arxiv.org/help/submit_tex.html',
    'https://info.arxiv.org/help/faq/texlive.html',
  ],
  checkedOn: '2026-11-17',
  /** The TeX Live arXiv uses unless the submitter picks another one. */
  defaultYear: 2025,
  versions: [
    { year: 2025, biblatex: '3.20', biber: '2.20', bblFormats: ['3.3'] },
    { year: 2023, biblatex: '3.19', biber: '2.19', bblFormats: ['3.2', '3.3'] },
  ] as ArxivTexLive[],
  /** TeX processors arXiv offers for LaTeX (besides `latex` in DVI mode). */
  engines: ['pdflatex', 'xelatex'],
} as const;

/** The biblatex .bbl format version from the header of a .bbl, e.g. `3.3`. */
export function bblFormatVersion(text: string): string | undefined {
  return /biblatex bbl format version (\d+(?:\.\d+)*)/.exec(text.slice(0, 2000))?.[1];
}
