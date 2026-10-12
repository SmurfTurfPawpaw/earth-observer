"""Local supervised fixed Commission PDF extraction; no database or API writes.
Original bytes are never rewritten. The parent kills a timed-out child process.
Peak memory is NOT isolated: production execution remains an explicit gate.
"""
import base64
import datetime
import hashlib
import io
import json
import logging
import subprocess
import sys
import urllib.request

SOURCE = 'https://ec.europa.eu/commission/presscorner/api/files/document/print/en/statement_26_2127/STATEMENT_26_2127_EN.pdf'
RAW_LIMIT = 524288
OUTPUT_LIMIT = 1048576
TEXT_LIMIT = 65536
TIME_LIMIT = 20


def extract(raw, mode, acquired):
    import pypdf
    logging.getLogger('pypdf').disabled = True
    if pypdf.__version__ != '6.10.0' or not raw.startswith(b'%PDF-1.') or len(raw) > RAW_LIMIT:
        raise ValueError('Unsupported fixed extraction input/runtime')
    reader = pypdf.PdfReader(io.BytesIO(raw), strict=True)
    if reader.is_encrypted or not 1 <= len(reader.pages) <= 4:
        raise ValueError('Unsupported document page/encryption scope')
    if '/OpenAction' in reader.root_object or '/AA' in reader.root_object:
        raise ValueError('Active PDF actions are outside this policy')
    pages = []
    total_bytes = 0
    for number, page in enumerate(reader.pages, 1):
        stream = page.get_contents()
        decoded = stream.get_data() if stream is not None else b''
        if len(decoded) > 1048576:
            raise ValueError('Decoded page budget exceeded')
        text = page.extract_text() or ''
        encoded = text.encode('utf-8')
        total_bytes += len(encoded)
        if not 1 <= len(text) <= 16384 or total_bytes > TEXT_LIMIT:
            raise ValueError('Extracted text budget exceeded')
        pages.append({'page': number, 'text': text, 'textSha256': hashlib.sha256(encoded).hexdigest(), 'characters': len(text)})
    complete = ' '.join(' '.join(page['text'] for page in pages).split())
    for required in ['European Commission - Statement', 'Statement on the International Criminal Court following announcement of US sanctions',
                     'STATEMENT/26/2127', 'Brussels, 9 October 2026']:
        if required not in complete:
            raise ValueError('Fixed source document identity mismatch')
    creation = (reader.metadata or {}).get('/CreationDate')
    if creation is not None and (not isinstance(creation, str) or len(creation) > 80):
        raise ValueError('Unsupported rendering metadata')
    return {'schemaVersion': 1, 'policyId': 'ec-statement-pdf-v1', 'sourceUrl': SOURCE,
            'inputMode': mode, 'acquiredAt': acquired, 'rawPdfSha256': hashlib.sha256(raw).hexdigest(), 'rawPdfBytes': len(raw),
            'extractor': {'name': 'pypdf', 'version': pypdf.__version__, 'mode': 'default-extract-text',
                          'normalization': 'none', 'offsetUnit': 'unicode-code-points'},
            'pages': pages, 'pdfCreationDateRaw': creation,
            'runtime': {'mode': 'local-supervised', 'wallTimeSeconds': TIME_LIMIT, 'peakMemoryEnforced': False}}


def child(fetch_source, include_original):
    acquired = None
    if fetch_source:
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                raise ValueError('Unexpected fixed-source redirect')
        request = urllib.request.Request(SOURCE, headers={'Accept': 'application/pdf', 'User-Agent': 'earth-observer-document-research/1.0'})
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=10) as response:
            if response.status != 200 or response.headers.get_content_type() != 'application/pdf':
                raise ValueError('Unsupported fixed source response')
            raw = response.read(RAW_LIMIT + 1)
        acquired = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    else:
        raw = sys.stdin.buffer.read(RAW_LIMIT + 1)
    value = {'extraction': extract(raw, 'fixed-fetch' if fetch_source else 'stdin', acquired)}
    if include_original:
        value['originalPdfBase64'] = base64.b64encode(raw).decode('ascii')
    output = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(output) > OUTPUT_LIMIT:
        raise ValueError('Extraction output budget exceeded')
    sys.stdout.buffer.write(output)


def main():
    args = sys.argv[1:]
    if any(arg not in ['--fetch', '--include-original'] for arg in args) or len(args) != len(set(args)):
        raise ValueError('Use stdin or the fixed --fetch source; no arbitrary URL/path arguments')
    # Child owns even stdin reading; the parent can stop a blocked producer/read.
    code = f"import runpy; runpy.run_path({__file__!r})['child']({'--fetch' in args!r}, {'--include-original' in args!r})"
    command = [sys.executable, '-I', '-B', '-c', code]
    process = subprocess.Popen(command, stdin=sys.stdin.buffer, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        output, _ = process.communicate(timeout=TIME_LIMIT)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        raise ValueError('Local extraction exceeded its process wall-time budget')
    if process.returncode or len(output) > OUTPUT_LIMIT:
        raise ValueError('Fixed document extraction failed')
    sys.stdout.buffer.write(output)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stderr.write('Bounded local document extraction failed; no artifact published.\n')
        sys.exit(1)
