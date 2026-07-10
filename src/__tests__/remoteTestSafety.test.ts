import { describe, expect, it } from 'vitest';
import {
  assertDedicatedRemoteTestProject,
  assertRunScopedEventKey,
} from '../../tests/remoteTestSafety';

describe('remote test safety', () => {
  it('fails closed unless the explicitly allowed project matches the URL', () => {
    expect(() => assertDedicatedRemoteTestProject({})).toThrow(/Remote tests refused/);
    expect(() =>
      assertDedicatedRemoteTestProject({
        VITE_SUPABASE_URL: 'https://production.supabase.co',
        TEST_SUPABASE_PROJECT_REF: 'dedicated-test',
      }),
    ).toThrow(/does not match/);
    expect(
      assertDedicatedRemoteTestProject({
        VITE_SUPABASE_URL: 'https://dedicated-test.supabase.co',
        TEST_SUPABASE_PROJECT_REF: 'dedicated-test',
      }),
    ).toBe('dedicated-test');
  });

  it('rejects destructive fixture keys outside the current run', () => {
    expect(() => assertRunScopedEventKey('2026casnv', 'run_123')).toThrow(/not run-scoped/);
    expect(() => assertRunScopedEventKey('_e2etest_run_123', 'local')).toThrow(
      /must identify this test run/,
    );
    expect(() => assertRunScopedEventKey('_e2etest_run_123', 'run-123')).not.toThrow();
  });
});
