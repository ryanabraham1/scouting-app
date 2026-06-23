// src/sync/__tests__/classifyError.test.ts
import { describe, it, expect } from 'vitest';
import { classifySyncError } from '../classifyError';

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
  });
});
