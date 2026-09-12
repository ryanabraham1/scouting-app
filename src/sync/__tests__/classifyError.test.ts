// src/sync/__tests__/classifyError.test.ts
import { describe, it, expect } from 'vitest';
import {
  classifySyncError,
  isAuthClassError,
  isSupersedeRecoverable,
  isOrphanedScoutRecoverable,
  isAutoRepairableReportValidationError,
} from '../classifyError';

describe('classifySyncError', () => {
  describe('transient (→ retry with backoff)', () => {
    it('classifies a fetch TypeError as transient', () => {
      expect(classifySyncError(new TypeError('Failed to fetch'))).toBe('transient');
    });

    it('classifies a NetworkError-message object as transient', () => {
      expect(classifySyncError({ message: 'NetworkError when attempting to fetch resource' })).toBe(
        'transient',
      );
    });

    it('classifies any TypeError as transient', () => {
      expect(classifySyncError(new TypeError('Load failed'))).toBe('transient');
    });

    it('classifies HTTP 500 as transient', () => {
      expect(classifySyncError({ status: 500 })).toBe('transient');
    });

    it('classifies HTTP 503 (string code) as transient', () => {
      expect(classifySyncError({ code: '503' })).toBe('transient');
    });

    it('classifies HTTP 408 (request timeout) as transient', () => {
      expect(classifySyncError({ status: 408 })).toBe('transient');
    });

    it('classifies HTTP 429 (rate limited) as transient', () => {
      expect(classifySyncError({ status: 429 })).toBe('transient');
    });

    it('classifies a null/empty response as transient', () => {
      expect(classifySyncError(null)).toBe('transient');
      expect(classifySyncError(undefined)).toBe('transient');
    });

    it('classifies Postgres connection/resource/serialization SQLSTATEs as transient', () => {
      expect(classifySyncError({ code: '08006' })).toBe('transient'); // connection_failure
      expect(classifySyncError({ code: '08003' })).toBe('transient'); // connection_does_not_exist
      expect(classifySyncError({ code: '53300' })).toBe('transient'); // too_many_connections
      expect(classifySyncError({ code: '57P03' })).toBe('transient'); // cannot_connect_now
      expect(classifySyncError({ code: '40001' })).toBe('transient'); // serialization_failure
      expect(classifySyncError({ code: '40P01' })).toBe('transient'); // deadlock_detected
    });

    it('classifies an unknown/ambiguous error as transient', () => {
      expect(classifySyncError({ message: 'something weird' })).toBe('transient');
      expect(classifySyncError('plain string')).toBe('transient');
      expect(classifySyncError({})).toBe('transient');
    });
  });

  describe('terminal (→ dead-letter)', () => {
    it('classifies the ownership-gate code 42501 as terminal', () => {
      expect(classifySyncError({ code: '42501' })).toBe('terminal');
    });

    it('classifies a PostgREST validation code (PGRST204) as terminal', () => {
      expect(classifySyncError({ code: 'PGRST204', message: 'column not found' })).toBe('terminal');
    });

    it('classifies HTTP 400 (bad request) as terminal', () => {
      expect(classifySyncError({ status: 400 })).toBe('terminal');
    });

    it('classifies HTTP 401 (unauthorized) as terminal', () => {
      expect(classifySyncError({ status: 401 })).toBe('terminal');
    });

    it('classifies HTTP 403 (forbidden) as terminal', () => {
      expect(classifySyncError({ status: 403 })).toBe('terminal');
    });

    it('classifies HTTP 422 (validation) as terminal', () => {
      expect(classifySyncError({ status: 422 })).toBe('terminal');
    });

    it('classifies a string 4xx code (other than 408/429) as terminal', () => {
      expect(classifySyncError({ code: '404' })).toBe('terminal');
    });

    it('still classifies the one-active-report unique violation 23505 as terminal', () => {
      // It dead-letters immediately, but is later auto-requeued once the 0025
      // supersede fix ships (see isSupersedeRecoverable).
      expect(classifySyncError({ code: '23505' })).toBe('terminal');
    });
  });
});

describe('isSupersedeRecoverable', () => {
  it('matches the one-active-report-per-match unique-index violation', () => {
    expect(
      isSupersedeRecoverable(
        'duplicate key value violates unique constraint "idx_msr_match_scout_active"',
      ),
    ).toBe(true);
  });

  it('does NOT match unrelated errors', () => {
    expect(isSupersedeRecoverable('invalid input syntax for type integer')).toBe(false);
    expect(isSupersedeRecoverable('Failed to fetch')).toBe(false);
    expect(isSupersedeRecoverable(null)).toBe(false);
    expect(isSupersedeRecoverable(undefined)).toBe(false);
  });
});

describe('isOrphanedScoutRecoverable (BUG-6: narrowed so a real match/team FK stays terminal)', () => {
  it('matches a genuinely scout-related FK failure', () => {
    expect(isOrphanedScoutRecoverable('invalid scout_id')).toBe(true);
    expect(isOrphanedScoutRecoverable('no such scout for this event')).toBe(true);
    expect(
      isOrphanedScoutRecoverable('insert violates foreign key constraint on scout_id'),
    ).toBe(true);
  });

  it('does NOT match a match_key / target_team FK violation (the BUG-1 dead-letter)', () => {
    // Postgres uses 23503 for ALL foreign-key violations; the bare code must no
    // longer flag a bad-match-key dead-letter as recoverable, or it would be
    // pointlessly auto-requeued and just dead-letter again.
    expect(
      isOrphanedScoutRecoverable(
        'insert or update violates foreign key constraint "match_scouting_report_match_key_fkey" (23503)',
      ),
    ).toBe(false);
    expect(
      isOrphanedScoutRecoverable(
        'violates foreign key constraint "match_scouting_report_target_team_number_fkey"',
      ),
    ).toBe(false);
    expect(isOrphanedScoutRecoverable(null)).toBe(false);
    expect(isOrphanedScoutRecoverable(undefined)).toBe(false);
  });
});

describe('isAuthClassError', () => {
  it('matches the ownership-gate 42501 message', () => {
    expect(isAuthClassError('42501: permission denied')).toBe(true);
    expect(isAuthClassError('not authorized: scout_id not owned by caller')).toBe(true);
    expect(isAuthClassError('insufficient_privilege')).toBe(true);
  });

  it('matches HTTP 401/403 and PGRST301 auth errors', () => {
    expect(isAuthClassError('Ingest failed (401)')).toBe(true);
    expect(isAuthClassError('403 Forbidden')).toBe(true);
    expect(isAuthClassError('PGRST301: JWT expired')).toBe(true);
  });

  it('does NOT match validation / network / empty messages', () => {
    expect(isAuthClassError('PGRST204: column not found')).toBe(false);
    expect(isAuthClassError('Failed to fetch')).toBe(false);
    expect(isAuthClassError('invalid input syntax for type integer')).toBe(false);
    expect(isAuthClassError(null)).toBe(false);
    expect(isAuthClassError(undefined)).toBe(false);
    expect(isAuthClassError('')).toBe(false);
  });
});

describe('isAutoRepairableReportValidationError', () => {
  it.each([
    'fuel burst value is outside its range',
    'auto_path is malformed',
    'defense_intervals contains a malformed interval',
    'climb_level must be a JSON number',
    'inactive_first_source is invalid',
  ])('accepts sanitizer-covered validator failure: %s', (message) => {
    expect(isAutoRepairableReportValidationError(message)).toBe(true);
  });

  it.each([
    'match report identity fields are required',
    'match report seat is invalid',
    'unsupported match report schema_version: 99',
    'violates foreign key constraint match_scouting_report_match_key_fkey',
    'Match report upload conflicted with server revision 7',
    'Failed to fetch',
  ])('keeps unsafe or non-validation recovery manual: %s', (message) => {
    expect(isAutoRepairableReportValidationError(message)).toBe(false);
  });
});
