/** Intake source selections, independently overridable by Factory project. */

import { FactoryStorageDomain, UniqueViolationError } from '@mastra/core/storage';
import type { CollectionSchema, FactoryStorageOps } from '@mastra/core/storage';

export interface IntakeSelection {
  enabled: boolean;
  /** Provider-owned source ids; `null` means nothing is selected. */
  sourceIds: string[] | null;
  repositoryByLinearProject?: Record<string, string>;
}

export type IntakeConfig = Record<string, IntakeSelection>;

export const DEFAULT_INTAKE_CONFIG: IntakeConfig = {};

export const INTAKE_ORG_SETTINGS_SCHEMA: CollectionSchema = {
  name: 'intake_org_settings',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    config: { type: 'json' },
    created_at: { type: 'timestamp' },
    updated_at: { type: 'timestamp' },
  },
  uniqueIndexes: [{ name: 'intake_org_settings_org_unique', columns: ['org_id'] }],
};

/** Project overrides are additive. Legacy organization settings remain intact for safe migration. */
export const INTAKE_PROJECT_SETTINGS_SCHEMA: CollectionSchema = {
  name: 'intake_project_settings',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text' },
    config: { type: 'json' },
    created_at: { type: 'timestamp' },
    updated_at: { type: 'timestamp' },
  },
  uniqueIndexes: [{ name: 'intake_project_settings_org_project_unique', columns: ['org_id', 'factory_project_id'] }],
};

/** Collection evolution is additive, so the per-member unique index cannot be narrowed: rows stay and are folded at boot. */
export const LEGACY_INTAKE_USER_SETTINGS_SCHEMA: CollectionSchema = {
  name: 'intake_settings',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    user_id: { type: 'text' },
    config: { type: 'json' },
    created_at: { type: 'timestamp' },
    updated_at: { type: 'timestamp' },
  },
  uniqueIndexes: [{ name: 'intake_settings_org_user_unique', columns: ['org_id', 'user_id'] }],
};

/** What the org effectively saw while selections were personal: a member's sources fed the shared board only while their switch was on. */
export function mergeIntakeSelections(configs: readonly IntakeConfig[]): IntakeConfig {
  const merged: IntakeConfig = Object.create(null);
  for (const config of configs) {
    for (const [integrationId, selection] of Object.entries(config)) {
      const current = merged[integrationId] ?? { enabled: false, sourceIds: null };
      const syncing = selection.enabled ? (selection.sourceIds ?? []) : [];
      const sourceIds = [...new Set([...(current.sourceIds ?? []), ...syncing])];
      merged[integrationId] = {
        enabled: current.enabled || selection.enabled,
        sourceIds: sourceIds.length ? sourceIds : null,
      };
    }
  }
  return merged;
}

/**
 * Binds an intake source to the Factory project its items belong to.
 *
 * Legacy organization selections cannot say *where* an
 * ingested item should land. GitHub items are naturally scoped by their linked
 * repository; providers without that link (Linear) need this explicit binding
 * so viewing one project's board cannot materialize another project's items.
 */
export const INTAKE_SOURCE_BINDINGS_SCHEMA: CollectionSchema = {
  name: 'intake_source_bindings',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    integration_id: { type: 'text' },
    source_id: { type: 'text' },
    factory_project_id: { type: 'text' },
    /** Installed board the source feeds; `null` keeps the legacy source-type routing (issues → work, PRs → review). */
    board: { type: 'text', nullable: true },
    created_by_user_id: { type: 'text', nullable: true },
    created_at: { type: 'timestamp' },
    updated_at: { type: 'timestamp' },
  },
  indexes: [{ name: 'intake_source_bindings_project_idx', columns: ['org_id', 'factory_project_id'] }],
  uniqueIndexes: [
    {
      name: 'intake_source_bindings_org_integration_source_unique',
      columns: ['org_id', 'integration_id', 'source_id'],
    },
  ],
};

export interface IntakeSourceBinding {
  integrationId: string;
  sourceId: string;
  factoryProjectId: string;
  /** Installed board the source feeds, or `null` for legacy source-type routing. */
  board: string | null;
}

/**
 * Routes items carrying a label to an installed board, per Factory project.
 *
 * Repository-scoped providers (GitHub) already know which project an item
 * belongs to, but one repository can feed several boards: an issue labelled
 * `release` belongs on a release board while the rest stay on Work. Labels
 * without a route fall back to the provider's built-in board.
 */
export const INTAKE_LABEL_ROUTES_SCHEMA: CollectionSchema = {
  name: 'intake_label_routes',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text' },
    integration_id: { type: 'text' },
    /** Label as the provider reports it; matched case-insensitively. */
    label: { type: 'text' },
    board: { type: 'text' },
    created_by_user_id: { type: 'text', nullable: true },
    created_at: { type: 'timestamp' },
    updated_at: { type: 'timestamp' },
  },
  indexes: [{ name: 'intake_label_routes_project_idx', columns: ['org_id', 'factory_project_id'] }],
  uniqueIndexes: [
    {
      name: 'intake_label_routes_org_project_integration_label_unique',
      columns: ['org_id', 'factory_project_id', 'integration_id', 'label'],
    },
  ],
};

export interface IntakeLabelRoute {
  factoryProjectId: string;
  integrationId: string;
  label: string;
  board: string;
}

type IntakeLabelRouteRow = {
  factory_project_id: string;
  integration_id: string;
  label: string;
  board: string;
};
function toIntakeLabelRoute(row: IntakeLabelRouteRow): IntakeLabelRoute {
  return {
    factoryProjectId: row.factory_project_id,
    integrationId: row.integration_id,
    label: row.label,
    board: row.board,
  };
}

/** Labels are matched the way GitHub treats them: case-insensitively. */
export function normalizeIntakeLabel(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * The board a labelled item should land on under `routes`, or `undefined` when
 * none of its labels is routed. Ties resolve to the first route in `routes`
 * order, so callers should pass a deterministically ordered list.
 */
export function resolveIntakeLabelRoute(
  routes: readonly IntakeLabelRoute[],
  labels: readonly string[] | undefined,
): IntakeLabelRoute | undefined {
  if (!labels?.length) return undefined;
  const normalized = new Set(labels.map(normalizeIntakeLabel));
  return routes.find(route => normalized.has(normalizeIntakeLabel(route.label)));
}

type IntakeSourceBindingRow = {
  integration_id: string;
  source_id: string;
  factory_project_id: string;
  board?: string | null;
};
function toIntakeSourceBinding(row: IntakeSourceBindingRow): IntakeSourceBinding {
  return {
    integrationId: row.integration_id,
    sourceId: row.source_id,
    factoryProjectId: row.factory_project_id,
    board: row.board ?? null,
  };
}

export class IntakeStorage extends FactoryStorageDomain {
  constructor() {
    super('intake');
  }

  async init(): Promise<void> {
    await this.ensureCollections([
      INTAKE_ORG_SETTINGS_SCHEMA,
      INTAKE_PROJECT_SETTINGS_SCHEMA,
      LEGACY_INTAKE_USER_SETTINGS_SCHEMA,
      INTAKE_SOURCE_BINDINGS_SCHEMA,
      INTAKE_LABEL_ROUTES_SCHEMA,
    ]);
    await this.#foldLegacyUserSelections();
  }

  async #foldLegacyUserSelections(): Promise<void> {
    const legacyRows = await this.ops.findMany<{ org_id: string; config: IntakeConfig }>('intake_settings', {});
    const byOrg = new Map<string, IntakeConfig[]>();
    for (const row of legacyRows) {
      byOrg.set(row.org_id, [...(byOrg.get(row.org_id) ?? []), row.config]);
    }
    for (const [orgId, configs] of byOrg) {
      const folded = await this.ops.findOne('intake_org_settings', { org_id: orgId });
      if (folded) continue;
      await this.#insertConfigIfAbsent(orgId, mergeIntakeSelections(configs));
    }
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.ops.deleteMany('intake_org_settings', {});
    await this.ops.deleteMany('intake_project_settings', {});
    await this.ops.deleteMany('intake_settings', {});
    await this.ops.deleteMany('intake_source_bindings', {});
    await this.ops.deleteMany('intake_label_routes', {});
  }

  get #db(): FactoryStorageOps {
    return this.ops;
  }

  async getConfig({
    orgId,
    factoryProjectId,
    integrationIds,
  }: {
    orgId: string;
    /** Read the project's own configuration, falling back to the legacy org settings until its first save. */
    factoryProjectId?: string;
    /**
     * When provided, the result contains exactly these integration ids, with
     * unset integrations defaulting to `{ enabled: true, sourceIds: null }`.
     */
    integrationIds?: string[];
  }): Promise<IntakeConfig> {
    const projectRow = factoryProjectId
      ? await this.#db.findOne<{ config: IntakeConfig }>('intake_project_settings', {
          org_id: orgId,
          factory_project_id: factoryProjectId,
        })
      : null;
    const row =
      projectRow ?? (await this.#db.findOne<{ config: IntakeConfig }>('intake_org_settings', { org_id: orgId }));
    const saved = structuredClone(row?.config ?? DEFAULT_INTAKE_CONFIG);
    if (!integrationIds) return saved;
    return Object.fromEntries(
      integrationIds.map(integrationId => [integrationId, saved[integrationId] ?? { enabled: true, sourceIds: null }]),
    );
  }

  /** Source-identity reconciliation must see selections in every Factory override, not only the legacy org row. */
  async listSelectedSourceIds({ orgId, integrationId }: { orgId: string; integrationId: string }): Promise<string[]> {
    const orgRow = await this.#db.findOne<{ config: IntakeConfig }>('intake_org_settings', { org_id: orgId });
    const projectRows = await this.#db.findMany<{ config: IntakeConfig }>('intake_project_settings', {
      org_id: orgId,
    });
    return [...new Set([orgRow, ...projectRows].flatMap(row => row?.config[integrationId]?.sourceIds ?? []))];
  }

  async saveConfig({
    orgId,
    factoryProjectId,
    config,
  }: {
    orgId: string;
    factoryProjectId?: string;
    config: IntakeConfig;
  }): Promise<void> {
    const now = new Date();
    const table = factoryProjectId ? 'intake_project_settings' : 'intake_org_settings';
    const where = { org_id: orgId, ...(factoryProjectId ? { factory_project_id: factoryProjectId } : {}) };
    const updated = await this.#db.updateMany(table, where, { config, updated_at: now });
    if (updated > 0) return;
    if (factoryProjectId) {
      try {
        await this.#db.insertOne(table, { ...where, config, created_at: now, updated_at: now });
        return;
      } catch (error) {
        if (!(error instanceof UniqueViolationError)) throw error;
      }
    } else if (await this.#insertConfigIfAbsent(orgId, config)) {
      return;
    }
    await this.#db.updateMany(table, where, { config, updated_at: now });
  }

  async #insertConfigIfAbsent(orgId: string, config: IntakeConfig): Promise<boolean> {
    const now = new Date();
    try {
      await this.#db.insertOne('intake_org_settings', { org_id: orgId, config, created_at: now, updated_at: now });
      return true;
    } catch (error) {
      if (error instanceof UniqueViolationError) return false;
      throw error;
    }
  }

  /** Every source binding in the org, optionally narrowed to one integration. */
  async listBindings({
    orgId,
    integrationId,
  }: {
    orgId: string;
    integrationId?: string;
  }): Promise<IntakeSourceBinding[]> {
    const rows = await this.#db.findMany<IntakeSourceBindingRow>('intake_source_bindings', {
      org_id: orgId,
      ...(integrationId ? { integration_id: integrationId } : {}),
    });
    return rows.map(toIntakeSourceBinding);
  }

  /** Source ids bound to one Factory project. Empty means "nothing bound". */
  async listBoundSourceIds({
    orgId,
    integrationId,
    factoryProjectId,
  }: {
    orgId: string;
    integrationId: string;
    factoryProjectId: string;
  }): Promise<string[]> {
    const rows = await this.#db.findMany<IntakeSourceBindingRow>('intake_source_bindings', {
      org_id: orgId,
      integration_id: integrationId,
      factory_project_id: factoryProjectId,
    });
    return rows.map(row => row.source_id);
  }

  /** The binding for one source, or `null` when it is unbound. */
  async getBinding({
    orgId,
    integrationId,
    sourceId,
  }: {
    orgId: string;
    integrationId: string;
    sourceId: string;
  }): Promise<IntakeSourceBinding | null> {
    const row = await this.#db.findOne<IntakeSourceBindingRow>('intake_source_bindings', {
      org_id: orgId,
      integration_id: integrationId,
      source_id: sourceId,
    });
    return row ? toIntakeSourceBinding(row) : null;
  }

  async clearBinding({
    orgId,
    integrationId,
    sourceId,
  }: {
    orgId: string;
    integrationId: string;
    sourceId: string;
  }): Promise<IntakeSourceBinding | null> {
    const where = { org_id: orgId, integration_id: integrationId, source_id: sourceId };
    return this.storage.withTransaction(
      async ops => {
        const row = await ops.findOne<IntakeSourceBindingRow>('intake_source_bindings', where);
        if (!row) return null;
        await ops.deleteMany('intake_source_bindings', where);
        return toIntakeSourceBinding(row);
      },
      { isolationLevel: 'serializable' },
    );
  }

  async setBinding({
    orgId,
    integrationId,
    sourceId,
    factoryProjectId,
    board = null,
    userId,
  }: {
    orgId: string;
    integrationId: string;
    sourceId: string;
    factoryProjectId: string;
    board?: string | null;
    userId?: string;
  }): Promise<void> {
    const where = { org_id: orgId, integration_id: integrationId, source_id: sourceId };
    const now = new Date();
    const patch = { factory_project_id: factoryProjectId, board, updated_at: now };
    const updated = await this.#db.updateMany('intake_source_bindings', where, patch);
    if (updated > 0) return;
    try {
      await this.#db.insertOne('intake_source_bindings', {
        ...where,
        factory_project_id: factoryProjectId,
        board,
        created_by_user_id: userId ?? null,
        created_at: now,
        updated_at: now,
      });
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
      await this.#db.updateMany('intake_source_bindings', where, patch);
    }
  }
  /** Atomically replace legacy provider source ids in both selection and routing state. */
  async migrateSourceIds({
    orgId,
    integrationId,
    migrations,
  }: {
    orgId: string;
    integrationId: string;
    migrations: Array<{ from: string; to: string }>;
  }): Promise<{ migrations: Array<{ from: string; to: string }>; conflicts: Array<{ from: string; to: string }> }> {
    if (migrations.length === 0) return { migrations: [], conflicts: [] };
    return this.storage.withTransaction(
      async ops => {
        const bindings = await ops.findMany<IntakeSourceBindingRow>('intake_source_bindings', {
          org_id: orgId,
          integration_id: integrationId,
        });
        const bindingBySource = new Map(bindings.map(binding => [binding.source_id, binding] as const));
        const grouped = new Map<string, Array<{ from: string; to: string }>>();
        for (const migration of migrations) {
          grouped.set(migration.to, [...(grouped.get(migration.to) ?? []), migration]);
        }
        const conflicts: Array<{ from: string; to: string }> = [];
        for (const [to, group] of grouped) {
          const candidates = [bindingBySource.get(to), ...group.map(({ from }) => bindingBySource.get(from))].filter(
            (binding): binding is IntakeSourceBindingRow => binding !== undefined,
          );
          const destinations = new Set(
            candidates.map(binding => `${binding.factory_project_id}\0${binding.board ?? ''}`),
          );
          if (destinations.size > 1) conflicts.push(...group);
        }
        if (conflicts.length > 0) return { migrations: [], conflicts };

        const now = new Date();
        for (const [to, group] of grouped) {
          const canonical = bindingBySource.get(to);
          const legacy = group.flatMap(({ from }) => {
            const binding = bindingBySource.get(from);
            return binding ? [{ from, binding }] : [];
          });
          if (!canonical && legacy.length > 0) {
            const [first, ...duplicates] = legacy;
            await ops.updateMany(
              'intake_source_bindings',
              { org_id: orgId, integration_id: integrationId, source_id: first!.from },
              { source_id: to, updated_at: now },
            );
            for (const duplicate of duplicates) {
              await ops.deleteMany('intake_source_bindings', {
                org_id: orgId,
                integration_id: integrationId,
                source_id: duplicate.from,
              });
            }
          } else if (canonical) {
            for (const entry of legacy) {
              await ops.deleteMany('intake_source_bindings', {
                org_id: orgId,
                integration_id: integrationId,
                source_id: entry.from,
              });
            }
          }
        }

        // Update both legacy defaults and every Factory override atomically, so a
        // provider's source-ID migration cannot silently disable project intake.
        const orgRow = await ops.findOne<{ config: IntakeConfig }>('intake_org_settings', { org_id: orgId });
        const projectRows = await ops.findMany<{ factory_project_id: string; config: IntakeConfig }>(
          'intake_project_settings',
          { org_id: orgId },
        );
        const replacements = new Map(migrations.map(({ from, to }) => [from, to] as const));
        for (const entry of [
          ...(orgRow ? [{ table: 'intake_org_settings', where: { org_id: orgId }, config: orgRow.config }] : []),
          ...projectRows.map(row => ({
            table: 'intake_project_settings',
            where: { org_id: orgId, factory_project_id: row.factory_project_id },
            config: row.config,
          })),
        ]) {
          const selected = entry.config[integrationId]?.sourceIds ?? [];
          const nextSelected = [...new Set(selected.map(sourceId => replacements.get(sourceId) ?? sourceId))];
          if (
            nextSelected.length !== selected.length ||
            nextSelected.some((sourceId, index) => sourceId !== selected[index])
          ) {
            const config = structuredClone(entry.config);
            config[integrationId] = {
              ...(config[integrationId] ?? { enabled: true }),
              sourceIds: nextSelected.length > 0 ? nextSelected : null,
            };
            await ops.updateMany(entry.table, entry.where, { config, updated_at: now });
          }
        }
        return { migrations, conflicts: [] };
      },
      { isolationLevel: 'serializable' },
    );
  }

  /** Label routes in the org, optionally narrowed to one project and/or integration. Sorted by label. */
  async listLabelRoutes({
    orgId,
    factoryProjectId,
    integrationId,
  }: {
    orgId: string;
    factoryProjectId?: string;
    integrationId?: string;
  }): Promise<IntakeLabelRoute[]> {
    const rows = await this.#db.findMany<IntakeLabelRouteRow>('intake_label_routes', {
      org_id: orgId,
      ...(factoryProjectId ? { factory_project_id: factoryProjectId } : {}),
      ...(integrationId ? { integration_id: integrationId } : {}),
    });
    return rows.map(toIntakeLabelRoute).sort((a, b) => a.label.localeCompare(b.label));
  }

  async setLabelRoute({
    orgId,
    factoryProjectId,
    integrationId,
    label,
    board,
    userId,
  }: {
    orgId: string;
    factoryProjectId: string;
    integrationId: string;
    label: string;
    board: string;
    userId?: string;
  }): Promise<void> {
    const where = {
      org_id: orgId,
      factory_project_id: factoryProjectId,
      integration_id: integrationId,
      label: normalizeIntakeLabel(label),
    };
    const now = new Date();
    const patch = { board, updated_at: now };
    const updated = await this.#db.updateMany('intake_label_routes', where, patch);
    if (updated > 0) return;
    try {
      await this.#db.insertOne('intake_label_routes', {
        ...where,
        board,
        created_by_user_id: userId ?? null,
        created_at: now,
        updated_at: now,
      });
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
      await this.#db.updateMany('intake_label_routes', where, patch);
    }
  }

  /** Remove a label route; returns the route that was removed, or `null` when none existed. */
  async clearLabelRoute({
    orgId,
    factoryProjectId,
    integrationId,
    label,
  }: {
    orgId: string;
    factoryProjectId: string;
    integrationId: string;
    label: string;
  }): Promise<IntakeLabelRoute | null> {
    const where = {
      org_id: orgId,
      factory_project_id: factoryProjectId,
      integration_id: integrationId,
      label: normalizeIntakeLabel(label),
    };
    return this.storage.withTransaction(
      async ops => {
        const row = await ops.findOne<IntakeLabelRouteRow>('intake_label_routes', where);
        if (!row) return null;
        await ops.deleteMany('intake_label_routes', where);
        return toIntakeLabelRoute(row);
      },
      { isolationLevel: 'serializable' },
    );
  }
}
