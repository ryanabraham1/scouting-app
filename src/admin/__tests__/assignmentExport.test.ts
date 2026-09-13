import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { createAssignmentWorkbook } from '../assignmentExport';

describe('assignment workbook export', () => {
  it('creates readable match and pit sheets using scouter names', async () => {
    const bytes = await createAssignmentWorkbook({
      eventKey: '2026test',
      scouts: [
        { id: 'scout-a', displayName: 'Alex' },
        { id: 'scout-b', displayName: 'Blair' },
      ],
      teams: [
        { teamNumber: 111, nickname: 'Alpha' },
        { teamNumber: 222, nickname: 'Beta' },
      ],
      schedule: [
        {
          match_key: '2026test_qm2',
          event_key: '2026test',
          comp_level: 'qm',
          match_number: 2,
          scheduled_time: '2026-09-12T17:30:00.000Z',
          predicted_time: null,
          red1: 111,
          red2: null,
          red3: null,
          blue1: 222,
          blue2: null,
          blue3: null,
          actual_red_score: null,
          actual_blue_score: null,
          winner: null,
          result_synced_at: null,
        },
      ],
      matches: [
        {
          matchKey: '2026test_qm2',
          scoutId: 'scout-a',
          allianceColor: 'red',
          station: 1,
          targetTeamNumber: 111,
        },
      ],
      pitAssignments: [
        { teamNumber: 222, scoutId: 'scout-b', source: 'auto' },
        { teamNumber: 222, scoutId: 'scout-a', source: 'auto' },
      ],
    });

    const zip = await JSZip.loadAsync(bytes);
    const workbook = await zip.file('xl/workbook.xml')?.async('string');
    const matches = await zip.file('xl/worksheets/sheet1.xml')?.async('string');
    const pits = await zip.file('xl/worksheets/sheet2.xml')?.async('string');

    expect(workbook).toContain('name="Match Assignments"');
    expect(workbook).toContain('name="Pit Assignments"');
    expect(matches).toContain('Qualification 2');
    expect(matches).toContain('<t xml:space="preserve">Alex</t>');
    expect(matches).toContain('<v>111</v>');
    expect(matches).toContain('state="frozen"');
    expect(matches).toContain('<autoFilter ref="A1:F2"/>');
    expect(pits).toContain('<t xml:space="preserve">Beta</t>');
    expect(pits).toContain('<t xml:space="preserve">Alex, Blair</t>');
    expect(pits).toContain('<v>2</v>');
    expect(pits).toContain('state="frozen"');
  });
});
