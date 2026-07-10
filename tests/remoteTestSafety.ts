const RUN_SCOPED_EVENT_PREFIX = '_e2etest_';

function projectRef(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Remote tests refused: VITE_SUPABASE_URL is not a valid URL.');
  }

  const ref = parsed.hostname.split('.')[0];
  if (!ref || !parsed.hostname.endsWith('.supabase.co')) {
    throw new Error('Remote tests refused: VITE_SUPABASE_URL must target a Supabase project.');
  }
  return ref;
}

/**
 * Fail closed before any remote test can authenticate or mutate data.
 *
 * The operator must explicitly name the dedicated test project in
 * TEST_SUPABASE_PROJECT_REF. Merely having production credentials in
 * .env.local is intentionally insufficient.
 */
export function assertDedicatedRemoteTestProject(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = env.VITE_SUPABASE_URL ?? env.SUPABASE_URL;
  const expectedRef = env.TEST_SUPABASE_PROJECT_REF?.trim();
  if (!url || !expectedRef) {
    throw new Error(
      'Remote tests refused: set VITE_SUPABASE_URL and TEST_SUPABASE_PROJECT_REF for a dedicated test project.',
    );
  }

  const actualRef = projectRef(url);
  if (actualRef !== expectedRef) {
    throw new Error(
      `Remote tests refused: URL project "${actualRef}" does not match TEST_SUPABASE_PROJECT_REF "${expectedRef}".`,
    );
  }
  return actualRef;
}

export function assertRunScopedEventKey(
  eventKey: string,
  runId = process.env.E2E_RUN_ID,
): void {
  const safeRunId = runId?.replace(/[^a-zA-Z0-9_]/g, '_');
  if (!safeRunId || safeRunId === 'local') {
    throw new Error('Destructive fixture refused: E2E_RUN_ID must identify this test run.');
  }
  const expected = `${RUN_SCOPED_EVENT_PREFIX}${safeRunId}`;
  if (eventKey !== expected) {
    throw new Error(
      `Destructive fixture refused: event key "${eventKey}" is not run-scoped as "${expected}".`,
    );
  }
}
