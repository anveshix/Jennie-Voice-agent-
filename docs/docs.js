/**
 * Document writer for the phone app.
 *
 * The chat runs in a browser with no server, so a Word file is built here as a
 * real .docx: an OOXML package (zip) with document.xml + styles + core props.
 * No library, no network — a Blob handed straight to the download prompt.
 *
 * Two entry points:
 *   looksLikeDocRequest(text)  → "doc file banao", "word me do", "PDF chahiye"
 *   buildDocx(title, bodyText) → Blob
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_DOCS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

  const escapeXml = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  /** Very small Markdown subset: #/## headings, - / * bullets, 1. lists, **bold**. */
  function parseLines(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((raw) => {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) return { kind: 'gap' };
        if (/^#{1,6}\s+/.test(line)) return { kind: 'heading', text: line.replace(/^#{1,6}\s+/, '') };
        if (/^\s*[-*•]\s+/.test(line)) return { kind: 'bullet', text: line.replace(/^\s*[-*•]\s+/, '') };
        if (/^\s*\d+[.)]\s+/.test(line)) return { kind: 'number', text: line.replace(/^\s*\d+[.)]\s+/, '') };
        return { kind: 'plain', text: line };
      });
  }

  function run(text, bold) {
    const rpr = '<w:rPr>' + (bold ? '<w:b/>' : '') + '<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>';
    // split **bold** runs so emphasis survives without a full Markdown parser
    const parts = String(text).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
    return parts.map((part) => {
      const isBold = bold || /^\*\*[^*]+\*\*$/.test(part);
      const clean = isBold ? part.replace(/^\*\*|\*\*$/g, '') : part;
      return `<w:r>${rpr.replace(bold ? '' : '<w:b/>', '')}<w:t xml:space="preserve">${escapeXml(clean)}</w:t></w:r>`;
    }).join('');
  }

  function para(entry) {
    if (entry.kind === 'gap') return '<w:p/>';
    if (entry.kind === 'heading') {
      return '<w:p><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>' + run(entry.text, true) + '</w:p>';
    }
    if (entry.kind === 'bullet' || entry.kind === 'number') {
      const mark = entry.kind === 'bullet' ? '•' : '1.';
      return '<w:p><w:pPr><w:ind w:left="360" w:hanging="220"/></w:pPr>'
        + run(mark + ' ' + entry.text) + '</w:p>';
    }
    return '<w:p>' + run(entry.text) + '</w:p>';
  }

  function buildDocument(title, text) {
    const entries = parseLines(text);
    const body = (title ? [{ kind: 'heading', text: title }, { kind: 'gap' }] : [])
      .concat(entries)
      .map(para)
      .join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}">
  <w:body>
    ${body}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
  }

  const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

  const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
      <w:sz w:val="24"/><w:szCs w:val="24"/>
    </w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
</w:styles>`;

  /* ── a tiny zip writer (deflate is not allowed on this path: stored only) ── */

  function crc32(bytes) {
    let table = crc32.table;
    if (!table) {
      table = crc32.table = new Uint32Array(256);
      for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function zip(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;

    files.forEach((file) => {
      const nameBytes = encoder.encode(file.name);
      const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
      const crc = crc32(data);

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);          // version needed
      lv.setUint16(6, 0x0800, true);      // UTF-8 flag
      lv.setUint16(8, 0, true);           // stored
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);

      chunks.push(local, data);

      const dir = new Uint8Array(46 + nameBytes.length);
      const dv = new DataView(dir.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, 0, true);
      dv.setUint32(16, crc, true);
      dv.setUint32(20, data.length, true);
      dv.setUint32(24, data.length, true);
      dv.setUint16(28, nameBytes.length, true);
      dv.setUint32(42, offset, true);
      dir.set(nameBytes, 46);
      central.push(dir);

      offset += local.length + data.length;
    });

    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    return new Blob(chunks.concat(central, [end]), {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
  }

  /** Build a .docx Blob from plain text (Markdown-lite: #, -, 1., **bold**). */
  function buildDocx(title, text) {
    const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(title || 'Document')}</dc:title>
  <dc:creator>Jenni</dc:creator>
  <cp:lastModifiedBy>Jenni</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`;

    return zip([
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: '_rels/.rels', data: ROOT_RELS },
      { name: 'word/document.xml', data: buildDocument(title, text) },
      { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
      { name: 'word/styles.xml', data: STYLES },
      { name: 'docProps/core.xml', data: core }
    ]);
  }

  const DOC_WORDS = /\b(docx?|word file|word me|word mein|ms word|pdf|txt|text file|markdown|md file|csv|json file|html file|file banao|file bana do|file chahiye|download karna|document banao|document chahiye|application likho|letter likho|resume banao)\b/i;

  /**
   * Is the reply itself a document? Header + formal body + signature lines is a
   * letter/application regardless of what the user typed, so the download
   * button can appear even when no trigger word was used.
   */
  function looksLikeDocumentText(text) {
    const value = String(text || '');
    if (value.length < 140) return false;
    const formalHeader = /(respected (sir|madam)|dear (sir|madam)|to\s*\n\s*the principal|subject\s*:)/i.test(value);
    const closing = /(yours (obediently|sincerely|faithfully)|thanking you|sincerely,|regards,)/i.test(value);
    const signature = /\[\s*(your )?name\s*\]|\[your full name\]/i.test(value);
    return (formalHeader && (closing || signature)) || (formalHeader && value.split('\n').length > 8);
  }

  /**
   * Does this message ask for a downloadable document?
   * Deliberately conservative: "write an email" stays in chat; "doc file banao"
   * or "word me do" produces a file.
   */
  function looksLikeDocRequest(text) {
    const value = String(text || '');
    if (!value || value.length > 900) return false;
    if (!DOC_WORDS.test(value)) return false;
    // a question about documents is not a request to make one
    if (/^(what|why|how|kya|kyun|kaise|kaun)\b/i.test(value.trim())) return false;
    return true;
  }

  /** Which file does the request ask for? docx unless they named a type. */
  function docFormatFor(request) {
    const value = String(request || '').toLowerCase();
    if (/\bcsv\b/.test(value)) return 'csv';
    if (/\bjson\b/.test(value)) return 'json';
    if (/\bhtml\b/.test(value)) return 'html';
    if (/\b(md|markdown)\b/.test(value)) return 'md';
    if (/\b(txt|text file|plain text)\b/.test(value)) return 'txt';
    return 'docx';
  }

  /** Plain-text files need no packaging at all. */
  function buildTextFile(title, text, format) {
    const body = format === 'csv' ? toCsv(text)
      : format === 'json' ? toJson(title, text)
        : format === 'html' ? toHtml(title, text)
          : String(text || '');
    const types = {
      txt: 'text/plain;charset=utf-8',
      md: 'text/markdown;charset=utf-8',
      csv: 'text/csv;charset=utf-8',
      json: 'application/json',
      html: 'text/html;charset=utf-8'
    };
    return new Blob([body], { type: types[format] || 'text/plain;charset=utf-8' });
  }

  function toCsv(text) {
    return String(text || '')
      .split('\n')
      .filter((line) => line.trim() && !/^\s*[#-]/.test(line))
      .map((line) => line.split(/\s*\|\s*|\t|,(?![^(]*\))/).map((cell) => {
        const clean = cell.replace(/^\s+|\s+$/g, '').replace(/\*\*/g, '');
        return /[",\n]/.test(clean) ? '"' + clean.replace(/"/g, '""') + '"' : clean;
      }).join(','))
      .join('\n');
  }

  function toJson(title, text) {
    return JSON.stringify({ title: title || 'Jenni document', generatedAt: new Date().toISOString(), text: String(text || '') }, null, 2);
  }

  function toHtml(title, text) {
    const safe = escapeXml(title || 'Jenni document');
    const body = String(text || '')
      .split(/\n{2,}/)
      .map((block) => {
        const heading = (block.match(/^#{1,6}\s+(.+)$/m) || [])[1];
        if (heading) return '<h2>' + escapeXml(heading.replace(/^#+\s*/, '')) + '</h2>';
        return '<p>' + escapeXml(block).replace(/\n/g, '<br>') + '</p>';
      })
      .join('\n');
    return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
      + '<title>' + safe + '</title>\n'
      + '<style>body{font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;'
      + 'max-width:46rem;margin:2rem auto;padding:0 1rem;color:#111}h2{margin-top:1.6em}</style>\n'
      + '</head>\n<body>\n' + body + '\n</body>\n</html>\n';
  }

  /** A safe, human filename: "Leave application 23 Nov 2026.docx" */
  function docFileName(title, format) {
    const ext = format || 'docx';
    const base = String(title || 'Jenni document')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'Jenni document';
    return base + '.' + ext;
  }

  /** One call the app can use: right blob + right name for this request. */
  function buildFile(title, text, request) {
    const format = docFormatFor(request);
    const blob = format === 'docx' ? buildDocx(title, text) : buildTextFile(title, text, format);
    return { blob, format, name: docFileName(title, format) };
  }

  return {
    buildDocx, buildFile, buildTextFile, docFormatFor, docFileName,
    looksLikeDocRequest, looksLikeDocumentText, parseLines, crc32, escapeXml
  };
});
