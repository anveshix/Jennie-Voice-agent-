#!/usr/bin/env python3
"""Build a real .docx (Word) leave application with the standard library only.

Word files are a zip of XML parts, so no python-docx dependency is needed.
Run:  python3 tools/make-leave-docx.py
"""
import os
import zipfile

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   'Leave-Application-23-11-2026.docx')

PARAS = [
    ('plain', 'To'),
    ('plain', 'The Principal'),
    ('plain', '[School / College Name]'),
    ('plain', ''),
    ('plain', 'Date: 23/11/2026'),
    ('plain', ''),
    ('bold', 'Subject: Application for leave on Monday, 23/11/2026 (personal reasons)'),
    ('plain', ''),
    ('plain', 'Respected Sir / Madam,'),
    ('plain', ''),
    ('just', 'With due respect, I would like to state that I, [Your Full Name], a student of '
             'Class [   ] / Section [   ], Roll No. [   ], am unable to attend school on '
             'Monday, 23/11/2026, because of personal reasons.'),
    ('just', 'I therefore request you to kindly grant me leave for that day. I will collect the '
             'notes for the classes I miss and complete all pending work on the day I return.'),
    ('plain', ''),
    ('plain', 'Thanking you in anticipation.'),
    ('plain', ''),
    ('plain', 'Yours obediently,'),
    ('plain', ''),
    ('plain', ''),
    ('bold', '[Your Full Name]'),
    ('plain', 'Class: [   ]    Section: [   ]    Roll No.: [   ]'),
    ('plain', 'Contact: [Parent\u2019s phone number]'),
]

W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def para(kind, text):
    if kind == 'bold':
        run = ('<w:r><w:rPr><w:b/><w:sz w:val="24"/></w:rPr>'
               f'<w:t xml:space="preserve">{esc(text)}</w:t></w:r>')
    else:
        run = f'<w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">{esc(text)}</w:t></w:r>'
    ppr = ''
    if kind == 'just':
        ppr = '<w:pPr><w:jc w:val="both"/></w:pPr>'
    elif not text:
        ppr = '<w:pPr></w:pPr>'
    return f'<w:p>{ppr}{run}</w:p>'


def esc(value):
    return (value.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


document = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="{W_NS}">
  <w:body>
    {''.join(para(k, t) for k, t in PARAS)}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>'''

content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>'''

rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>'''

doc_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''

styles = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="{W_NS}">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
        <w:sz w:val="24"/>
        <w:szCs w:val="24"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/><w:qFormat/>
  </w:style>
</w:styles>'''

core = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Leave application - 23/11/2026</dc:title>
  <dc:creator>Jenni</dc:creator>
  <cp:lastModifiedBy>Jenni</cp:lastModifiedBy>
</cp:coreProperties>'''

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', content_types)
    z.writestr('_rels/.rels', rels)
    z.writestr('word/document.xml', document)
    z.writestr('word/_rels/document.xml.rels', doc_rels)
    z.writestr('word/styles.xml', styles)
    z.writestr('docProps/core.xml', core)

print('wrote', OUT, os.path.getsize(OUT), 'bytes')
