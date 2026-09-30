#!/usr/bin/env python3
"""Fast PDF -> markdown extraction for research mode.

This is the "fast" engine and the fallback for a Docling run that cannot
finish. It runs in seconds per paper and needs no GPU and no model download.

Two backends, tried in order:

1. `pdftext` — a CPU text extractor that sorts layout blocks into reading
   order. It installs from pip without pulling in torch, so the fast path
   costs nothing extra to install.
2. `pypdfium2` — raw per-page text. No layout pass at all: a two-column paper
   comes out interleaved, tables come out as loose lines. Used only when
   pdftext is missing.

Neither backend extracts figures. Figure descriptions need a layout model to
say which image belongs to which caption, so that pass stays with Docling; the
caller tells the user when a conversion ran without figures.

Usage:
    python3 pdf_to_markdown.py <input.pdf> <output_dir>

Writes <output_dir>/<stem>.md. Exits non-zero with a message on stderr when
neither backend is importable, so the app can tell "not installed" apart from
"this PDF failed".
"""

import os
import sys

# pdftext spawns a process pool for page extraction by default and kills
# workers that fail its health check — the same machinery that force-kills
# Docling's layout worker on a low-memory machine. One worker keeps peak memory
# at a single PDF page's worth and still runs far faster than the layout pass
# it replaces.
PDFTEXT_WORKERS = 1


def via_pdftext(source: str) -> str | None:
    try:
        from pdftext.extraction import plain_text_output
    except ImportError:
        return None

    return plain_text_output(
        source,
        sort=True,
        hyphens=True,
        workers=PDFTEXT_WORKERS,
    )


def via_pypdfium2(source: str) -> str | None:
    try:
        import pypdfium2 as pdfium
    except ImportError:
        return None

    document = pdfium.PdfDocument(source)
    pages = []
    for index in range(len(document)):
        page = document[index]
        text = page.get_textpage().get_text_range()
        # A page break is a stronger boundary than a blank line: the chunker
        # and the model both read `\n\n` as "new paragraph", and without it
        # the last line of one page runs into the first line of the next.
        pages.append(f"{text.strip()}\n")
    document.close()
    return "\n\n".join(pages)


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: pdf_to_markdown.py <input.pdf> <output_dir>", file=sys.stderr)
        return 2

    source, output_dir = sys.argv[1], sys.argv[2]
    if not os.path.isfile(source):
        print(f"input not found: {source}", file=sys.stderr)
        return 2

    backend = "pdftext"
    try:
        markdown = via_pdftext(source)
    except Exception as error:  # noqa: BLE001 - reported to the app verbatim
        print(f"pdftext failed: {error}", file=sys.stderr)
        markdown = None

    if markdown is None or not markdown.strip():
        backend = "pypdfium2"
        try:
            markdown = via_pypdfium2(source)
        except Exception as error:  # noqa: BLE001
            print(f"pypdfium2 failed: {error}", file=sys.stderr)
            return 1

    if markdown is None or not markdown.strip():
        # A PDF with no extractable text is almost always a scan. There is no
        # OCR path by design (Docling runs with --disable_ocr to stay on CPU),
        # so this is a dead end the user needs told about.
        print(
            "no extractable text — this PDF is probably a scan, and OCR is "
            "disabled to keep conversion on the CPU",
            file=sys.stderr,
        )
        return 1

    os.makedirs(output_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(source))[0]
    with open(os.path.join(output_dir, f"{stem}.md"), "w", encoding="utf-8") as handle:
        handle.write(markdown)

    # The backend is reported on stdout so the app can say which one ran: the
    # two differ in reading order, and a user comparing output across
    # documents needs to know which produced what.
    print(f"backend: {backend}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
