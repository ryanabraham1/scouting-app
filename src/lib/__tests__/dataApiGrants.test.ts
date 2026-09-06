import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const EDGE_FUNCTIONS = join(ROOT, 'supabase/functions');
const MIGRATION_PATH = join(
  ROOT,
  'supabase/migrations/20260722181527_explicit_browser_data_api_grants.sql',
);

type TablePrivilege = 'select' | 'insert' | 'update' | 'delete';
type DataApiUsage = {
  tables: Record<string, Set<TablePrivilege>>;
  rpcs: Set<string>;
};
type EdgeClientRole = 'caller' | 'service';

const EXPECTED_TABLE_PRIVILEGES: Record<string, TablePrivilege[]> = {
  assignment: ['select'],
  event: ['select'],
  event_team: ['select'],
  match: ['select'],
  match_scouting_report: ['select'],
  matchup_note: ['select'],
  nexus_event_status: ['select'],
  picklist: ['insert', 'select', 'update'],
  pit_assignment: ['select'],
  pit_scouting_report: ['select'],
  scout: ['select'],
  scouter_roster: ['delete', 'insert', 'select'],
  strategy_canvas: ['select'],
  team: ['select'],
};

const EXPECTED_SERVICE_ROLE_TABLE_PRIVILEGES: Record<string, TablePrivilege[]> = {
  event: ['select'],
  event_secret: ['select'],
  match: ['insert', 'select', 'update'],
};

const PRIVATE_TABLES = [
  'assignment_batch_revision',
  'event_secret',
  'matchup_note_history',
  'pit_report_history',
  'profile',
];

const EXPECTED_BROWSER_RPCS = [
  'delete_event(text)',
  'delete_roster_scouter(text)',
  'get_assignment_batch_state(text,text)',
  'seed_event_scouts_from_roster(text)',
  'select_scouter(text,text)',
  'set_active_event(text)',
  'set_assignments(text,jsonb,bigint)',
  'set_pit_assignments(text,jsonb,bigint)',
  'set_roster_hidden(text,boolean)',
  'upsert_match_report(jsonb)',
  'upsert_matchup_note(jsonb)',
  'upsert_pit_report(jsonb)',
  'upsert_strategy_canvas(jsonb)',
];

const EXPECTED_CALLER_EDGE_RPCS = ['get_my_event_keys()'];

const EXPECTED_SERVICE_ROLE_EDGE_RPCS = [
  'nexus_upsert_status',
  'promote_event_import',
  'replace_demo_event_bundle',
  'upsert_match_report',
];

// These existed or were granted earlier in the migration chain, but are not
// current browser/caller-JWT APIs. The reset-plus-allowlist must keep them
// unreachable even when upgrading an older project with explicit grants already
// in pg_proc ACLs.
const FORBIDDEN_BROWSER_RPC_NAMES = [
  'delete_scout',
  'get_my_scout_ids',
  'is_admin',
  'is_staff',
  'join_event',
  'nexus_upsert_status',
  'normalized_qualitative_rating',
  'promote_event_import',
  'recompute_match_report_aggregates',
  'recover_identity',
  'replace_demo_event_bundle',
  'rotate_join_code',
  'seed_demo_event',
  'skill_of',
  'validate_match_report_payload',
] as const;

const FORBIDDEN_BROWSER_SIGNATURES = [
  // Legacy last-writer-wins wrappers; only the current CAS overloads are public.
  'set_assignments(text,jsonb)',
  'set_pit_assignments(text,jsonb)',
] as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(path);
    }
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)
      ? [path]
      : [];
  });
}

function literalArgument(call: ts.CallExpression): string | null {
  const arg = call.arguments[0];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

function chainedMethods(call: ts.CallExpression): string[] {
  const methods: string[] = [];
  let node: ts.Node = call;
  while (
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node &&
    ts.isCallExpression(node.parent.parent) &&
    node.parent.parent.expression === node.parent
  ) {
    methods.push(node.parent.name.text);
    node = node.parent.parent;
  }
  return methods;
}

function emptyUsage(): DataApiUsage {
  return { tables: {}, rpcs: new Set<string>() };
}

function recordDataApiCall(call: ts.CallExpression, usage: DataApiUsage): void {
  if (ts.isIdentifier(call.expression) && call.expression.text === 'rpc') {
    const name = literalArgument(call);
    if (name) usage.rpcs.add(name);
    return;
  }
  if (!ts.isPropertyAccessExpression(call.expression)) return;
  const method = call.expression.name.text;
  if (method === 'from') {
    const table = literalArgument(call);
    if (!table) return;
    const ops = usage.tables[table] ?? new Set<TablePrivilege>();
    for (const chainedMethod of chainedMethods(call)) {
      if (chainedMethod === 'upsert') {
        ops.add('insert');
        ops.add('update');
      } else if (
        chainedMethod === 'select' ||
        chainedMethod === 'insert' ||
        chainedMethod === 'update' ||
        chainedMethod === 'delete'
      ) {
        ops.add(chainedMethod);
      }
    }
    usage.tables[table] = ops;
  } else if (method === 'rpc') {
    const name = literalArgument(call);
    if (name) usage.rpcs.add(name);
  }
}

function dataApiUsage(dir: string): DataApiUsage {
  const usage = emptyUsage();
  for (const path of sourceFiles(dir)) {
    const source = ts.createSourceFile(
      relative(ROOT, path),
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) recordDataApiCall(node, usage);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return usage;
}

function browserDataApiUsage() {
  return dataApiUsage(SRC);
}

function createClientRole(call: ts.CallExpression): EdgeClientRole | null {
  if (!ts.isIdentifier(call.expression) || call.expression.text !== 'createClient') {
    return null;
  }
  const key = call.arguments[1]?.getText().toUpperCase() ?? '';
  if (key.includes('SERVICE') || key.includes('SECRET')) return 'service';
  if (key.includes('ANON') || key.includes('PUBLISHABLE')) return 'caller';
  return null;
}

function singleCreatedClientRole(node: ts.Node): EdgeClientRole | null {
  const roles = new Set<EdgeClientRole>();
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child)) {
      const role = createClientRole(child);
      if (role) roles.add(role);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return roles.size === 1 ? [...roles][0] : null;
}

function edgeDataApiUsage(): {
  caller: DataApiUsage;
  service: DataApiUsage;
  unclassified: string[];
} {
  const caller = emptyUsage();
  const service = emptyUsage();
  const unclassified: string[] = [];

  for (const path of sourceFiles(EDGE_FUNCTIONS)) {
    const source = ts.createSourceFile(
      relative(ROOT, path),
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const clients = new Map<string, EdgeClientRole>();
    const factories = new Map<string, EdgeClientRole>();

    const collectClients = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) {
        if (ts.isCallExpression(node.initializer)) {
          const role = createClientRole(node.initializer);
          if (role) clients.set(node.name.text, role);
        } else if (
          ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer)
        ) {
          const role = singleCreatedClientRole(node.initializer);
          if (role) factories.set(node.name.text, role);
        }
      } else if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        const role = singleCreatedClientRole(node.body);
        if (role) factories.set(node.name.text, role);
      }
      ts.forEachChild(node, collectClients);
    };
    collectClients(source);

    const receiverRole = (receiver: ts.Expression): EdgeClientRole | null => {
      if (ts.isIdentifier(receiver)) return clients.get(receiver.text) ?? null;
      if (
        ts.isCallExpression(receiver) &&
        ts.isIdentifier(receiver.expression)
      ) {
        return factories.get(receiver.expression.text) ?? null;
      }
      return null;
    };

    const collectUsage = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === 'from' || node.expression.name.text === 'rpc') &&
        literalArgument(node)
      ) {
        const role = receiverRole(node.expression.expression);
        if (role) {
          recordDataApiCall(node, role === 'caller' ? caller : service);
        } else {
          unclassified.push(
            `${relative(ROOT, path)}:${node.expression.name.text}(${literalArgument(node)})`,
          );
        }
      }
      ts.forEachChild(node, collectUsage);
    };
    collectUsage(source);
  }

  return { caller, service, unclassified: unclassified.sort() };
}

function migrationTableGrants(
  sql: string,
  role: 'anon' | 'authenticated' | 'service_role',
): Record<string, Set<TablePrivilege>> {
  const grants: Record<string, Set<TablePrivilege>> = {};
  const pattern = /grant\s+([a-z,\s]+?)\s+on\s+table\s+(.+?)\s+to\s+([^;]+);/gis;
  for (const match of sql.matchAll(pattern)) {
    const roles = match[3].split(',').map((value) => value.trim().toLowerCase());
    if (!roles.includes(role)) continue;
    const privileges = match[1]
      .split(',')
      .map((value) => value.trim().toLowerCase() as TablePrivilege);
    const tables = match[2]
      .split(',')
      .map((value) => value.trim().replace(/^public\./i, ''));
    for (const table of tables) {
      const existing = grants[table] ?? new Set<TablePrivilege>();
      privileges.forEach((privilege) => existing.add(privilege));
      grants[table] = existing;
    }
  }
  return grants;
}

function sortedPrivileges(record: Record<string, Set<TablePrivilege>>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(record)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([table, privileges]) => [table, [...privileges].sort()]),
  );
}

function migrationBrowserRpcGrants(sql: string): string[] {
  const grants: string[] = [];
  const pattern =
    /grant\s+execute\s+on\s+function\s+public\.([a-z_][a-z0-9_]*\s*\([^;]*?\))\s+to\s+anon\s*,\s*authenticated\s*;/gis;
  for (const match of sql.matchAll(pattern)) {
    grants.push(match[1].replace(/\s+/g, '').toLowerCase());
  }
  return grants.sort();
}

describe('explicit browser Data API grants', () => {
  const migration = readFileSync(MIGRATION_PATH, 'utf8').toLowerCase();
  const compactMigration = migration.replace(/\s+/g, ' ');

  it('matches every direct browser table operation exactly', () => {
    const usage = browserDataApiUsage();
    expect(sortedPrivileges(usage.tables)).toEqual(EXPECTED_TABLE_PRIVILEGES);
    expect(sortedPrivileges(migrationTableGrants(migration, 'anon'))).toEqual(
      EXPECTED_TABLE_PRIVILEGES,
    );
    expect(sortedPrivileges(migrationTableGrants(migration, 'authenticated'))).toEqual(
      EXPECTED_TABLE_PRIVILEGES,
    );
  });

  it('classifies caller-JWT and service-role Edge Function access separately', () => {
    const usage = edgeDataApiUsage();
    expect(usage.unclassified).toEqual([]);
    expect(sortedPrivileges(usage.caller.tables)).toEqual({});
    expect([...usage.caller.rpcs].sort()).toEqual(
      EXPECTED_CALLER_EDGE_RPCS.map((signature) => signature.replace(/\(.*/, '')).sort(),
    );
    expect(sortedPrivileges(usage.service.tables)).toEqual(
      EXPECTED_SERVICE_ROLE_TABLE_PRIVILEGES,
    );
    expect([...usage.service.rpcs].sort()).toEqual(EXPECTED_SERVICE_ROLE_EDGE_RPCS);
    expect(sortedPrivileges(migrationTableGrants(migration, 'service_role'))).toEqual(
      EXPECTED_SERVICE_ROLE_TABLE_PRIVILEGES,
    );
  });

  it('keeps private tables and the private history sequence closed', () => {
    for (const table of PRIVATE_TABLES) {
      expect(migrationTableGrants(migration, 'anon')[table]).toBeUndefined();
      expect(migrationTableGrants(migration, 'authenticated')[table]).toBeUndefined();
      expect(compactMigration).toContain(`public.${table}`);
    }
    expect(compactMigration).toContain(
      'revoke all privileges on sequence public.matchup_note_history_id_seq from anon, authenticated, service_role;',
    );
    expect(migration).not.toMatch(/(?:^|;)\s*grant\s+[^;]+\s+on\s+sequence\b/is);
  });

  it('explicitly exposes every caller-role RPC to both Data API roles', () => {
    const browserUsage = browserDataApiUsage();
    expect([...browserUsage.rpcs].sort()).toEqual(
      EXPECTED_BROWSER_RPCS.map((signature) => signature.replace(/\(.*/, '')).sort(),
    );
    const edgeUsage = edgeDataApiUsage();
    expect([...edgeUsage.caller.rpcs].sort()).toEqual(
      EXPECTED_CALLER_EDGE_RPCS.map((signature) => signature.replace(/\(.*/, '')).sort(),
    );
    expect(migrationBrowserRpcGrants(migration)).toEqual(
      [...EXPECTED_BROWSER_RPCS, ...EXPECTED_CALLER_EDGE_RPCS].sort(),
    );
    expect(migration).not.toMatch(/grant\s+execute\s+on\s+function\s+.+?\s+to\s+public\b/is);
  });

  it('resets legacy grants and keeps future Data API objects opt-in', () => {
    expect(compactMigration).toContain(
      'revoke execute on all functions in schema public from public, anon, authenticated;',
    );
    expect(compactMigration).toContain(
      'grant execute on all functions in schema public to service_role;',
    );
    expect(compactMigration).toContain(
      'alter default privileges for role postgres in schema public revoke select, insert, update, delete on tables from anon, authenticated, service_role;',
    );
    expect(compactMigration).toContain(
      'alter default privileges for role postgres in schema public revoke usage, select on sequences from anon, authenticated, service_role;',
    );
    expect(compactMigration).toContain(
      'alter default privileges for role postgres revoke execute on functions from public;',
    );
    expect(compactMigration).toContain(
      'alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;',
    );
    expect(compactMigration).toContain(
      'alter default privileges for role postgres in schema public grant execute on functions to service_role;',
    );
    expect(compactMigration).not.toContain(
      'alter default privileges for role postgres in schema public revoke execute on functions from public',
    );
    expect(migration).not.toMatch(
      /alter\s+default\s+privileges[^;]*grant[^;]*on\s+(?:tables|sequences)\b[^;]*;/is,
    );
  });

  it('keeps legacy, destructive, helper, and service-only RPCs out of the effective browser manifest', () => {
    const granted = migrationBrowserRpcGrants(migration);
    const grantedNames = new Set(granted.map((signature) => signature.replace(/\(.*/, '')));
    for (const name of FORBIDDEN_BROWSER_RPC_NAMES) {
      expect(grantedNames, `${name} must not be browser executable`).not.toContain(name);
    }
    for (const signature of FORBIDDEN_BROWSER_SIGNATURES) {
      expect(granted, `${signature} must not be browser executable`).not.toContain(signature);
    }

    // Pin the two intended CAS overloads so a future broad name-only grant
    // cannot accidentally re-expose the legacy wrappers.
    expect(granted).toContain('set_assignments(text,jsonb,bigint)');
    expect(granted).toContain('set_pit_assignments(text,jsonb,bigint)');
  });
});
