/**
 * SOP PDF generator — converts a Markdown SOP string into a PDF Buffer.
 *
 * Uses pdfkit (pure-JS, no native deps). The Markdown is not fully rendered —
 * we parse the logical structure (headings, bullets, code blocks, tables)
 * and lay it out with PDFKit primitives so the result is clean and printable.
 */

import PDFDocument from 'pdfkit';

const COLORS = {
  bg:       '#0A0A0A',
  white:    '#FFFFFF',
  dim:      '#8A8A8A',
  accent:   '#9fd6a8',
  rule:     '#2A2A2A',
  codeBg:   '#161618',
};

const FONT = {
  regular: 'Helvetica',
  bold:    'Helvetica-Bold',
  mono:    'Courier',
};

// Line types
const LINE_TYPES = {
  h1:    /^# (.+)/,
  h2:    /^## (.+)/,
  h3:    /^### (.+)/,
  rule:  /^---\s*$/,
  table: /^\|/,
  bullet: /^- \*\*(.+?)\*\*:? ?(.*)$/,
  bulletPlain: /^- (.+)/,
  codeOpen:  /^```/,
  blank:  /^\s*$/,
};

function parseLine(line) {
  if (LINE_TYPES.h1.test(line))          return { t: 'h1',    text: line.replace(LINE_TYPES.h1, '$1') };
  if (LINE_TYPES.h2.test(line))          return { t: 'h2',    text: line.replace(LINE_TYPES.h2, '$1') };
  if (LINE_TYPES.h3.test(line))          return { t: 'h3',    text: line.replace(LINE_TYPES.h3, '$1') };
  if (LINE_TYPES.rule.test(line))        return { t: 'rule' };
  if (LINE_TYPES.table.test(line))       return { t: 'table', raw: line };
  if (LINE_TYPES.bullet.test(line))      return { t: 'bullet',      key: line.replace(LINE_TYPES.bullet, '$1'), val: line.replace(LINE_TYPES.bullet, '$2') };
  if (LINE_TYPES.bulletPlain.test(line)) return { t: 'bulletPlain', text: line.replace(LINE_TYPES.bulletPlain, '$1') };
  if (LINE_TYPES.codeOpen.test(line))    return { t: 'codeToggle' };
  if (LINE_TYPES.blank.test(line))       return { t: 'blank' };
  return { t: 'para', text: line };
}

// Strip inline markdown bold/code from a string
function stripInline(s) {
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1').replace(/\*(.+?)\*/g, '$1');
}

export function generateSopPdf(markdown, workflowName = 'Workflow SOP') {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 60, bottom: 60, left: 64, right: 64 },
      info: { Title: workflowName, Author: 'Atlas', Subject: 'Standard Operating Procedure' },
    });

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 128; // usable width
    let inCode = false;
    const codeLines = [];

    function flushCode() {
      if (codeLines.length === 0) return;
      doc.moveDown(0.3);
      const text = codeLines.join('\n');
      doc.font(FONT.mono).fontSize(9).fillColor('#aaaaaa').text(text, { lineGap: 3 });
      codeLines.length = 0;
      doc.moveDown(0.3);
    }

    const lines = markdown.split('\n');
    // Group consecutive table lines
    const parsed = [];
    let i = 0;
    while (i < lines.length) {
      const p = parseLine(lines[i]);
      if (p.t === 'table') {
        const group = [lines[i]];
        i++;
        while (i < lines.length && LINE_TYPES.table.test(lines[i])) {
          group.push(lines[i]);
          i++;
        }
        parsed.push({ t: 'tableBlock', rows: group });
      } else {
        parsed.push(p);
        i++;
      }
    }

    for (const p of parsed) {
      if (inCode) {
        if (p.t === 'codeToggle') { inCode = false; flushCode(); }
        else codeLines.push(p.t === 'blank' ? '' : (p.text ?? p.raw ?? ''));
        continue;
      }

      switch (p.t) {
        case 'codeToggle':
          inCode = true;
          break;

        case 'h1':
          doc.moveDown(0.5)
            .font(FONT.bold).fontSize(20).fillColor(COLORS.white)
            .text(stripInline(p.text), { lineGap: 2 })
            .moveDown(0.3);
          break;

        case 'h2':
          doc.moveDown(0.8)
            .moveTo(doc.x, doc.y).lineTo(doc.x + W, doc.y).strokeColor(COLORS.rule).lineWidth(0.5).stroke()
            .moveDown(0.5)
            .font(FONT.bold).fontSize(14).fillColor(COLORS.accent)
            .text(stripInline(p.text), { lineGap: 2 })
            .moveDown(0.2);
          break;

        case 'h3':
          doc.moveDown(0.5)
            .font(FONT.bold).fontSize(11).fillColor(COLORS.white)
            .text(stripInline(p.text), { lineGap: 2 })
            .moveDown(0.15);
          break;

        case 'rule':
          doc.moveDown(0.4)
            .moveTo(doc.x, doc.y).lineTo(doc.x + W, doc.y).strokeColor(COLORS.rule).lineWidth(0.5).stroke()
            .moveDown(0.4);
          break;

        case 'bullet':
          doc.font(FONT.bold).fontSize(10).fillColor(COLORS.dim)
            .text(`${p.key}:  `, { continued: true })
            .font(FONT.regular).fillColor(COLORS.white)
            .text(stripInline(p.val || ''), { lineGap: 3 });
          break;

        case 'bulletPlain':
          doc.font(FONT.regular).fontSize(10).fillColor(COLORS.white)
            .text(`• ${stripInline(p.text)}`, { lineGap: 3 });
          break;

        case 'tableBlock': {
          // Render metadata table (| Field | Value | rows) as label: value pairs
          const dataRows = p.rows.filter(r => !r.match(/^\|[-| ]+\|$/));
          for (const row of dataRows) {
            const cells = row.split('|').map(c => c.trim()).filter(Boolean);
            if (cells.length >= 2) {
              doc.font(FONT.bold).fontSize(9.5).fillColor(COLORS.dim)
                .text(`${stripInline(cells[0])}: `, { continued: true })
                .font(FONT.regular).fillColor(COLORS.white)
                .text(stripInline(cells[1]), { lineGap: 3 });
            }
          }
          doc.moveDown(0.3);
          break;
        }

        case 'para':
          doc.font(FONT.regular).fontSize(10.5).fillColor(COLORS.white)
            .text(stripInline(p.text), { lineGap: 4, width: W });
          break;

        case 'blank':
          doc.moveDown(0.35);
          break;
      }
    }

    doc.end();
  });
}
