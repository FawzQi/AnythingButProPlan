#!/usr/bin/env python3
"""Docling extraction for research mode.

The default extractor runs the Docling CLI inside its own virtualenv —
Docling applies a real layout model on the GPU, so figures, charts and
two-column layouts survive the conversion. Docling embeds each extracted
figure inline as a `data:image/...;base64,...` URI, which is useless to the
vision pass that follows: the analyzer sends real files, not data URIs.
This wrapper runs Docling, then walks the markdown it produced, writes every
base64 blob to `<output_dir>/images/figure-N.<ext>`, and rewrites the
markdown so the figure links point at those files.

Keeping the whole exchange in one script — rather than spawning `docling`
from the app and post-processing its output separately — means the two steps
share the same notion of where the markdown and the images landed, and there
is one exit code to check.

Usage:
    docling_to_markdown.py <input> <output_dir> [--device cuda|cpu|auto]

Writes <output_dir>/<stem>.md plus <output_dir>/images/ when the document
has figures. Prints `backend: docling` and `figures: <count>` on stdout.
Exits non-zero with a message on stderr when Docling cannot run.
"""

import base64
import os
import re
import shutil
import subprocess
import sys
from urllib.parse import unquote

# Docling writes each figure as `![alt](data:image/png;base64,AAAA...)`. The
# payload can be line-wrapped by the encoder; the class below accepts the
# whitespace so the match survives a wrap at 76 columns. `)` is not in the
# class, so the match stops exactly at the closing paren of the markdown
# image syntax.
DATA_URI_RE = re.compile(
    r'!\[(?P<alt>[^\]]*)\]'
    r'\(\s*data:image/(?P<subtype>[a-zA-Z0-9.+-]+);base64,(?P<payload>[A-Za-z0-9+/=\s]+)\)'
)

# Subtypes Docling emits that viewers expect under a different extension.
EXTENSION_FOR_SUBTYPE = {
    'jpeg': 'jpg',
    'svg+xml': 'svg',
}

def docling_binary() -> str:
    """The `docling` CLI beside the interpreter running this script.

    The app spawns the Docling venv's python (see document-converter.ts), so
    `sys.executable` is `<venv>/bin/python` and the CLI is its sibling. That
    keeps the venv self-contained: nothing has to be on the system PATH, and
    the venv the app was pointed at is the venv that actually ran.
    """
    candidate = os.path.join(os.path.dirname(sys.executable), 'docling')
    if os.path.isfile(candidate):
        return candidate
    # Fall back to PATH for the case where a user ran this by hand from an
    # already-activated shell.
    return 'docling'

def run_docling(source: str, output_dir: str, device: str) -> None:
    command = [
        docling_binary(),
        source,
        '--to', 'md',
        '--output', output_dir,
        '--device', device,
    ]
    # Docling writes progress to stderr; capturing it lets a failure be
    # reported with the CLI's own last words rather than a bare exit code.
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout).strip().splitlines()[-5:]
        raise RuntimeError('\n'.join(tail) or f'exit code {result.returncode}')

def find_markdown(root: str, stem: str) -> str:
    """Locate the `.md` Docling wrote under `root`.

    Versions differ on whether the file lands at `<root>/<stem>.md` or
    `<root>/<stem>/<stem>.md`; both are checked, then any other file with the
    matching stem under the tree is accepted as a last resort so a future
    version that adds another layer of nesting still works.
    """
    direct = os.path.join(root, f'{stem}.md')
    if os.path.isfile(direct):
        return direct
    nested = os.path.join(root, stem, f'{stem}.md')
    if os.path.isfile(nested):
        return nested
    for current, _dirs, files in os.walk(root):
        for name in files:
            if name == f'{stem}.md':
                return os.path.join(current, name)
    raise RuntimeError(f'docling did not write a markdown file for {stem}')

def extract_base64_images(markdown: str, images_dir: str) -> tuple[str, int]:
    """Write every inline data URI to a file, rewriting the markdown to match.

    The rewritten links are relative (`images/figure-1.png`) because the
    markdown is read back with the images sitting beside it; an absolute path
    would break the moment the document is copied into `converted/`.
    """
    written = [0]

    def replace(match: 're.Match[str]') -> str:
        # Create the directory lazily so a figure-free document leaves no
        # empty `images/` behind — the caller treats the directory's absence
        # as "nothing to analyze", which is exactly right for a text PDF.
        if written[0] == 0:
            os.makedirs(images_dir, exist_ok=True)

        subtype = match.group('subtype').lower()
        extension = EXTENSION_FOR_SUBTYPE.get(subtype, subtype)
        name = f'figure-{written[0] + 1}.{extension}'
        payload = re.sub(r'\s+', '', match.group('payload'))
        try:
            data = base64.b64decode(payload, validate=False)
        except Exception as error:  # noqa: BLE001 - the source text is kept
            print(f'could not decode {name}: {error}', file=sys.stderr)
            return match.group(0)
        with open(os.path.join(images_dir, name), 'wb') as handle:
            handle.write(data)
        written[0] += 1
        alt = unquote(match.group('alt')) or 'figure'
        return f'![{alt}](images/{name})'

    rewritten = DATA_URI_RE.sub(replace, markdown)
    return rewritten, written[0]

def main() -> int:
    args = sys.argv[1:]
    if len(args) < 2:
        print(
            'usage: docling_to_markdown.py <input> <output_dir> [--device cuda|cpu|auto]',
            file=sys.stderr,
        )
        return 2

    source, output_dir = args[0], args[1]
    device = 'cuda'
    if '--device' in args:
        device = args[args.index('--device') + 1]

    if not os.path.isfile(source):
        print(f'input not found: {source}', file=sys.stderr)
        return 2

    os.makedirs(output_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(source))[0]

    # Docling writes wherever it likes inside its output directory (a
    # subfolder named after the document, or flat, depending on version).
    # Running it into a scratch subdir and then moving the pieces keeps the
    # final layout predictable: `<output_dir>/<stem>.md` with
    # `<output_dir>/images/` beside it, which is the shape the caller copies
    # into `converted/`.
    scratch = os.path.join(output_dir, '.docling')
    shutil.rmtree(scratch, ignore_errors=True)
    os.makedirs(scratch, exist_ok=True)

    try:
        run_docling(source, scratch, device)
    except FileNotFoundError:
        print(
            'docling is not available. Install it in the venv the app points '
            'at (DOCLING_VENV), or switch the extractor to the fast engine.',
            file=sys.stderr,
        )
        return 1
    except Exception as error:  # noqa: BLE001 - reported to the app verbatim
        print(f'docling failed: {error}', file=sys.stderr)
        return 1

    try:
        source_markdown = find_markdown(scratch, stem)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1

    with open(source_markdown, 'r', encoding='utf-8') as handle:
        markdown = handle.read()

    images_dir = os.path.join(output_dir, 'images')
    markdown, figures = extract_base64_images(markdown, images_dir)

    # Write the final markdown at a predictable path so the caller's
    # `findFirstWithExtension(workDir, '.md')` finds this file and not
    # Docling's own copy under the scratch tree.
    with open(os.path.join(output_dir, f'{stem}.md'), 'w', encoding='utf-8') as handle:
        handle.write(markdown)

    # The scratch tree is Docling's intermediate output; leaving it behind
    # would give the caller two `.md` files under `output_dir` to choose
    # from, with the base64 images still embedded in one of them.
    shutil.rmtree(scratch, ignore_errors=True)

    # The backend is reported on stdout so the app can record which engine
    # produced the markdown; `figures` decides whether the vision pass runs.
    print('backend: docling')
    print(f'figures: {figures}')
    return 0

if __name__ == '__main__':
    sys.exit(main())