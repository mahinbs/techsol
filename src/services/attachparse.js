'use strict';
/**
 * Attachment reader (WF1) — extracts RFQ text and line items from an enquiry
 * attachment (PDF, Word .docx, Excel .xlsx/.xls, CSV, or plain text). The raw
 * text is fed through the same heuristic line parser used for email bodies, so
 * attachments and typed enquiries produce line items on the identical contract.
 * For scanned/image PDFs the pluggable OCR/LLM provider takes over in
 * production; this baseline covers digital (text-bearing) documents.
 */
const XLSX = require('xlsx');
const { extractLines } = require('../extractor');

function ext(name) { return String(name || '').toLowerCase().split('.').pop(); }

// Turn HTML (from a Word .docx) into newline-separated text while KEEPING each
// table row on a single line: cell boundaries become spaces, row/block ends
// become newlines. This is what lets a tabular Word RFQ parse like a text one.
function htmlToLines(html) {
  return html
    .replace(/<t([dh])>\s*<p>/gi, '<t$1>')               // drop <p> wrappers that sit
    .replace(/<\/p>\s*<\/t([dh])>/gi, '</t$1>')           //   directly inside a table cell
    .replace(/<\/(td|th)>/gi, ' ')                       // cell end -> space
    .replace(/<\/(tr|p|h[1-6]|li|div)>/gi, '\n')          // row/block end -> newline
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')                              // strip remaining tags
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .split(/\n/).map(l => l.replace(/\s{2,}/g, ' ').trim()).filter(Boolean).join('\n');
}

async function extractText(buffer, filename) {
  const e = ext(filename);
  if (e === 'xlsx' || e === 'xls' || e === 'csv' || e === 'tsv') {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const out = [];
    for (const sn of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, blankrows: false, defval: '' });
      for (const r of rows) out.push(r.map(c => String(c == null ? '' : c)).join('  ').trim());
    }
    return out.join('\n');
  }
  if (e === 'pdf') {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const r = await parser.getText();
      // Drop page-number footers/headers so they are not misread as line items.
      // Handles bare ("1 of 1"), prefixed ("Page 1 of 1") and dash-wrapped
      // ("-- 1 of 1 --") forms.
      return String((r && r.text) || '')
        .split(/\r?\n/)
        .filter(l => !/^\s*[-–—]*\s*(page\s+)?\d+\s+of\s+\d+\s*[-–—]*\s*$/i.test(l))
        .join('\n');
    } finally { try { await parser.destroy(); } catch { /* ignore */ } }
  }
  if (e === 'docx') {
    const mammoth = require('mammoth');
    // Word RFQs almost always put the line items in a table. extractRawText
    // flattens each cell onto its own paragraph, which breaks "<qty> <desc>"
    // pairing. Convert to HTML instead and rebuild each table ROW as one line
    // (cells joined by spaces), so a row like S.No|Qty|UOM|Description becomes
    // "1 600 EA OD 08MM ..." — the same shape the line parser expects.
    const r = await mammoth.convertToHtml({ buffer });
    return htmlToLines(String((r && r.value) || ''));
  }
  // .doc (legacy) or unknown → best-effort printable-text scan
  if (e === 'doc') return buffer.toString('latin1').replace(/[^\x20-\x7E\n]+/g, ' ');
  return buffer.toString('utf8');
}

/**
 * @returns {{format:string, text:string, lines:Array}}
 */
async function extractFromBuffer(buffer, filename) {
  if (!buffer || !buffer.length) throw new Error('No file was received.');
  let text = '';
  try { text = await extractText(buffer, filename); }
  catch (e) { throw new Error(`Could not read the attachment (${ext(filename)}): ${e.message}`); }
  const lines = extractLines(text || '');
  return { format: ext(filename), text: text || '', lines };
}

module.exports = { extractFromBuffer };
