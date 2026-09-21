import type { CachedMatch } from '@/db/types';
import type { AssignScout, AssignTeam, Assignment, PitAssignment } from './types';

export interface AssignmentExportInput {
  eventKey: string;
  matches: Assignment[];
  pitAssignments: PitAssignment[];
  scouts: AssignScout[];
  teams: AssignTeam[];
  schedule: CachedMatch[];
}

export interface AssignmentWorkbookDownload {
  blobUrl: string;
  filename: string;
}

type CellValue = string | number | Date | null;

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function columnName(index: number): string {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function excelDate(value: Date): number {
  return value.getTime() / 86_400_000 + 25_569;
}

function cell(value: CellValue, row: number, column: number, striped: boolean): string {
  if (value == null) return '';
  const ref = `${columnName(column)}${row}`;
  if (value instanceof Date) {
    return `<c r="${ref}" s="${striped ? 4 : 2}" t="n"><v>${excelDate(value)}</v></c>`;
  }
  if (typeof value === 'number') {
    return `<c r="${ref}"${striped ? ' s="3"' : ''} t="n"><v>${value}</v></c>`;
  }
  return `<c r="${ref}"${striped ? ' s="3"' : ''} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function worksheetXml(headers: string[], rows: CellValue[][], widths: number[]): string {
  const lastColumn = columnName(headers.length - 1);
  const cols = widths
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join('');
  const headerCells = headers
    .map(
      (header, index) =>
        `<c r="${columnName(index)}1" s="1" t="inlineStr"><is><t>${xml(header)}</t></is></c>`,
    )
    .join('');
  const dataRows = rows
    .map((values, index) => {
      const rowNumber = index + 2;
      const striped = rowNumber % 2 === 0;
      return `<row r="${rowNumber}">${values
        .map((value, column) => cell(value, rowNumber, column, striped))
        .join('')}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData><row r="1" ht="24" customHeight="1">${headerCells}</row>${dataRows}</sheetData>
  <autoFilter ref="A1:${lastColumn}${Math.max(1, rows.length + 1)}"/>
</worksheet>`;
}

function matchNumber(matchKey: string): number {
  const match = /_qm(\d+)$/i.exec(matchKey);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function matchLabel(matchKey: string): string {
  const match = /_qm(\d+)$/i.exec(matchKey);
  return match ? `Qualification ${Number(match[1])}` : matchKey;
}

function safeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export async function createAssignmentWorkbook(
  input: AssignmentExportInput,
): Promise<Uint8Array> {
  const scoutNames = new Map(input.scouts.map((scout) => [scout.id, scout.displayName]));
  const teamNames = new Map(input.teams.map((team) => [team.teamNumber, team.nickname]));
  const schedule = new Map(input.schedule.map((match) => [match.match_key, match]));
  const nameFor = (scoutId: string): string => scoutNames.get(scoutId) ?? `Scout ${scoutId}`;

  const matchRows: CellValue[][] = [...input.matches]
    .sort(
      (a, b) =>
        matchNumber(a.matchKey) - matchNumber(b.matchKey) ||
        a.allianceColor.localeCompare(b.allianceColor) ||
        a.station - b.station,
    )
    .map((assignment) => {
      const match = schedule.get(assignment.matchKey);
      const timestamp = match?.predicted_time ?? match?.scheduled_time ?? null;
      return [
        matchLabel(assignment.matchKey),
        timestamp ? new Date(timestamp) : null,
        nameFor(assignment.scoutId),
        assignment.targetTeamNumber,
        assignment.allianceColor === 'red' ? 'Red' : 'Blue',
        assignment.station,
      ];
    });

  const pitByTeam = new Map<number, PitAssignment[]>();
  for (const assignment of input.pitAssignments) {
    const crew = pitByTeam.get(assignment.teamNumber) ?? [];
    crew.push(assignment);
    pitByTeam.set(assignment.teamNumber, crew);
  }
  const pitRows: CellValue[][] = [...pitByTeam.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([teamNumber, crew]) => [
      teamNumber,
      teamNames.get(teamNumber) ?? '',
      crew
        .map((assignment) => nameFor(assignment.scoutId))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        .join(', '),
      crew.length,
      crew.every((assignment) => assignment.source === 'auto') ? 'Auto' : 'Manual',
    ]);

  // Loaded on demand: jszip is ~97 KB and only this export needs it, so it
  // must not ride in the dashboard's route chunk.
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  );
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Match Assignments" sheetId="1" r:id="rId1"/><sheet name="Pit Assignments" sheetId="2" r:id="rId2"/></sheets>
</workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );
  zip.file(
    'xl/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font/><font><b/><color rgb="FFFFFFFF"/></font></fonts>
  <fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF164E63"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF0FDFA"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
    <xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>
    <xf numFmtId="22" fontId="0" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    worksheetXml(
      ['Match', 'Scheduled time', 'Scouter', 'Team', 'Alliance', 'Station'],
      matchRows,
      [20, 21, 24, 11, 12, 10],
    ),
  );
  zip.file(
    'xl/worksheets/sheet2.xml',
    worksheetXml(
      ['Team', 'Nickname', 'Assigned scouters', 'Crew size', 'Source'],
      pitRows,
      [11, 28, 42, 12, 14],
    ),
  );
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function assignmentWorkbookDownload(
  input: AssignmentExportInput,
): Promise<AssignmentWorkbookDownload> {
  const bytes = await createAssignmentWorkbook(input);
  const blobBytes = new Uint8Array(bytes.byteLength);
  blobBytes.set(bytes);
  const blob = new Blob([blobBytes.buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  return {
    blobUrl: URL.createObjectURL(blob),
    filename: `${safeFilenamePart(input.eventKey)}-scouting-assignments.xlsx`,
  };
}
