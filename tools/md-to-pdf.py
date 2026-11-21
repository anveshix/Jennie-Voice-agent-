#!/usr/bin/env python3
"""Render a Markdown guide to a styled A4 PDF with correct Devanagari shaping.

Why this exists: the Hindi guide needs real complex-script shaping (matras and
conjuncts), which most simple PDF helpers get wrong. fpdf2 with text shaping
enabled plus a full Noto Sans Devanagari (Latin + Devanagari in one cmap) gives
clean output without a browser or a headless Chromium.

Setup (one time, needs network):
    pip install fpdf2
    mkdir -p /tmp/fonts && cd /tmp/fonts
    npm pack @expo-google-fonts/noto-sans-devanagari
    tar -xzf expo-google-fonts-noto-sans-devanagari-*.tgz \
        package/400Regular/NotoSansDevanagari_400Regular.ttf \
        package/700Bold/NotoSansDevanagari_700Bold.ttf
    npm pack dejavu-fonts-ttf
    tar -xzf dejavu-fonts-ttf-*.tgz package/ttf/DejaVuSansMono.ttf

Usage:
    python3 tools/md-to-pdf.py Jenni-Setup-Guide-Hindi.md Jenni-Setup-Guide-Hindi.pdf
"""
import os
import re
import sys

from fpdf import FPDF

FONT_CANDIDATES = [
    ('/tmp/fonts/package/400Regular/NotoSansDevanagari_400Regular.ttf',
     '/tmp/fonts/package/700Bold/NotoSansDevanagari_700Bold.ttf',
     '/tmp/fonts/package/ttf/DejaVuSansMono.ttf'),
    ('/tmp/package/400Regular/NotoSansDevanagari_400Regular.ttf',
     '/tmp/package/700Bold/NotoSansDevanagari_700Bold.ttf',
     '/tmp/package/ttf/DejaVuSansMono.ttf'),
]

INK = (24, 32, 44)
MUTED = (95, 108, 124)
ACCENT = (28, 106, 224)
LINE = (222, 228, 236)

# The font has no arrow / dingbat glyphs; swap them for characters it owns.
GLYPH_FIX = {
    '\u2192': '\u203a',  # → to ›
    '\u21bb': '\u25b8',  # ↻ to ▸
    '\u2601': '',        # cloud
    '\u25e6': '\u2022',  # ◦ to •
    '\u2610': '-',
    '\u2611': 'x',
    '\u26a0': '',
    '\u22ee': '...',   # ⋮ vertical ellipsis
    '\U0001F916': '',   # 🤖
    '\U0001F399': '',   # 🎙
    '\U0001F507': '',   # 🔇
    '\U0001F50A': '',   # 🔊
    '\u2705': '[ok]',   # ✅
    '\u2713': 'ok',     # ✓
    '\u27a4': '-',      # ➤
    '\u2b06': '^',      # ⬆
    '\u2b50': '*',      # ⭐
    '\U0001F512': '',   # 🔒
    '\ufe0f': '',       # variation selector
    '\u23ee': '',
    '\u26a0\ufe0f': ''
}


def resolve_fonts():
    for regular, bold, mono in FONT_CANDIDATES:
        if os.path.exists(regular) and os.path.exists(bold) and os.path.exists(mono):
            return regular, bold, mono
    raise SystemExit('Fonts not found. See the header of this file for the fetch commands.')


def inline(text):
    text = re.sub(r'`([^`]*)`', r'\1', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)
    text = re.sub(r'(?<!\*)\*([^*]+)\*(?!\*)', r'\1', text)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'\1 (\2)', text)
    text = text.replace('&amp;', '&').replace('&nbsp;', ' ').replace('&lt;', '<').replace('&gt;', '>')
    for bad, good in GLYPH_FIX.items():
        text = text.replace(bad, good)
    return text.strip()


class Doc(FPDF):
    def __init__(self, fonts):
        super().__init__(format='A4', unit='mm')
        regular, bold, mono = fonts
        self.set_auto_page_break(auto=True, margin=18)
        self.set_margins(18, 18, 18)
        self.add_font('deva', '', regular)
        self.add_font('deva', 'B', bold)
        self.add_font('mono', '', mono)
        try:
            self.set_text_shaping(True)
        except Exception:
            pass

    def header(self):
        if self.page_no() == 1:
            return
        self.set_font('deva', '', 8)
        self.set_text_color(*MUTED)
        self.cell(0, 5, inline('Jenni — setup guide (Hindi)'), align='L')
        self.set_y(18)
        self.set_draw_color(*LINE)
        self.set_line_width(0.2)
        self.line(18, 15.5, 192, 15.5)
        self.ln(4)

    def footer(self):
        self.set_y(-14)
        self.set_font('deva', '', 8)
        self.set_text_color(*MUTED)
        self.cell(0, 5, str(self.page_no()), align='C')


def body(doc, text, size=10.5, lh=5.6, color=INK):
    doc.set_font('deva', '', size)
    doc.set_text_color(*color)
    doc.multi_cell(0, lh, text, align='L')
    doc.ln(1.4)


def heading(doc, text, level):
    sizes = {1: 19, 2: 13.5, 3: 11.2}
    tops = {1: 5, 2: 7.5, 3: 5.6}
    if doc.get_y() < 26:
        doc.set_y(24)
    doc.ln(tops[level])
    doc.set_font('deva', 'B', sizes[level])
    doc.set_text_color(*(ACCENT if level == 1 else INK))
    doc.multi_cell(0, sizes[level] * 0.46, text, align='L')
    if level == 1:
        doc.ln(1.2)
        doc.set_draw_color(*ACCENT)
        doc.set_line_width(0.6)
        doc.line(18, doc.get_y(), 78, doc.get_y())
        doc.ln(3.4)
    elif level == 2:
        doc.ln(2.2)
    else:
        doc.ln(1.6)


def bullets(doc, items, ordered):
    for i, item in enumerate(items):
        mark = f'{i + 1}.' if ordered else '\u2022'
        doc.set_text_color(*(ACCENT if ordered else MUTED))
        doc.set_font('deva', 'B' if ordered else '', 10.5)
        doc.set_x(20)
        doc.cell(6, 5.4, mark, align='L')
        doc.set_text_color(*INK)
        doc.set_font('deva', '', 10.5)
        doc.set_x(26)
        doc.multi_cell(166, 5.4, item, align='L')
        doc.ln(0.7)
    doc.ln(2)


def table(doc, rows):
    ncols = len(rows[0])
    widths = {2: [62, 112], 3: [46, 64, 64], 4: [36, 46, 46, 46]}.get(ncols, [174 / ncols] * ncols)
    scale = 174 / sum(widths)
    widths = [w * scale for w in widths]
    line_h = 5.0

    def paint(cells, bold=False, fill=None):
        doc.set_font('deva', 'B' if bold else '', 8.8)
        heights = []
        for w, c in zip(widths, cells):
            doc.set_font('deva', 'B' if bold else '', 8.8)
            n = len(doc.multi_cell(w, line_h, c, align='L', dry_run=True, output='LINES'))
            heights.append(max(1, n) * line_h)
        h = max(heights) + 2.6
        if doc.get_y() + h > doc.h - 20:
            doc.add_page()
        x, y = 18, doc.get_y()
        if fill:
            doc.set_fill_color(*fill)
            doc.rect(x, y, sum(widths), h, style='F')
        for w, c in zip(widths, cells):
            doc.set_xy(x, y + 1.3)
            doc.set_text_color(*(40, 52, 68) if bold else INK)
            doc.multi_cell(w, line_h, c, align='L', border=0)
            x += w
        doc.set_draw_color(*LINE)
        doc.line(18, y + h, 18 + sum(widths), y + h)
        doc.set_xy(18, y + h)

    paint([inline(c) for c in rows[0]], bold=True, fill=(242, 246, 252))
    for row in rows[1:]:
        paint([inline(c) for c in row])
    doc.ln(3.4)


def render(md_path, pdf_path, fonts):
    lines = open(md_path, encoding='utf-8').read().split('\n')
    doc = Doc(fonts)
    doc.add_page()
    paragraph = []
    i = 0

    def flush():
        nonlocal paragraph
        if paragraph:
            body(doc, ' '.join(paragraph))
            paragraph = []

    while i < len(lines):
        stripped = lines[i].strip()

        if not stripped:
            flush()
            i += 1
            continue

        if stripped.startswith('```'):
            flush()
            i += 1
            block = []
            while i < len(lines) and not lines[i].strip().startswith('```'):
                block.append(lines[i].rstrip())
                i += 1
            i += 1
            doc.set_font('mono', '', 8.6)
            doc.set_text_color(38, 48, 62)
            doc.set_fill_color(246, 248, 251)
            for bl in block or ['']:
                doc.set_x(18)
                doc.multi_cell(174, 4.8, bl.replace('\t', '  '), align='L', fill=True)
            doc.ln(2.5)
            continue

        if stripped.startswith('#'):
            flush()
            level = len(stripped) - len(stripped.lstrip('#'))
            heading(doc, inline(stripped.lstrip('#').strip()), min(level, 3))
            i += 1
            continue

        if stripped.startswith('|'):
            flush()
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r':?-{2,}:?', c or '--') for c in cells):
                    rows.append(cells)
                i += 1
            if rows:
                table(doc, rows)
            continue

        if re.match(r'^[-*]\s+', stripped):
            flush()
            items = []
            while i < len(lines) and re.match(r'^[-*]\s+', lines[i].strip()):
                items.append(inline(re.sub(r'^[-*]\s+', '', lines[i].strip())))
                i += 1
            bullets(doc, items, False)
            continue

        if re.match(r'^\d+\.\s+', stripped):
            flush()
            items = []
            while i < len(lines) and re.match(r'^\d+\.\s+', lines[i].strip()):
                items.append(inline(re.sub(r'^\d+\.\s+', '', lines[i].strip())))
                i += 1
            bullets(doc, items, True)
            continue

        if stripped.startswith('> '):
            flush()
            quote = []
            while i < len(lines) and lines[i].strip().startswith('>'):
                quote.append(inline(lines[i].strip().lstrip('>').strip()))
                i += 1
            doc.set_font('deva', '', 10)
            doc.set_text_color(*MUTED)
            y = doc.get_y()
            doc.set_x(22)
            doc.multi_cell(164, 5.2, ' '.join(quote), align='L')
            doc.set_draw_color(*ACCENT)
            doc.set_line_width(0.8)
            doc.line(19.5, y, 19.5, doc.get_y())
            doc.ln(3)
            continue

        if re.fullmatch(r'-{3,}|\*{3,}', stripped):
            flush()
            doc.set_draw_color(*LINE)
            doc.line(18, doc.get_y() + 1, 192, doc.get_y() + 1)
            doc.ln(4)
            i += 1
            continue

        paragraph.append(inline(stripped))
        i += 1

    flush()
    doc.output(pdf_path)
    return pdf_path


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: md-to-pdf.py input.md output.pdf')
    print('wrote', render(sys.argv[1], sys.argv[2], resolve_fonts()))
