import type { Introspection, ScopedCatalogTypes } from "pg-introspection";
import {
  makeIntrospectionQuery,
  makeSchemaScopedIntrospectionQuery,
} from "pg-introspection";

declare global {
  namespace GraphileBuild {
    interface GatherOptions {
      /**
       * Schema-scoped introspection options keyed by PostgreSQL service name.
       * `true` enables defaults, `false` disables, and an object customizes it.
       * Services without an entry continue to use stock introspection.
       */
      pgScopedIntrospection?: Readonly<
        Record<string, PgScopedIntrospectionServiceConfig>
      >;
    }
  }
}

export interface PgScopedIntrospectionOptions {
  /** Controls how many `pg_catalog` types scoped introspection retains. */
  catalogTypes?: ScopedCatalogTypes;

  /**
   * Extensions whose metadata should be retained even if no scoped object
   * directly depends on them.
   */
  capabilityExtensions?: readonly string[];
}

export type PgScopedIntrospectionServiceConfig =
  | boolean
  | PgScopedIntrospectionOptions;

export interface IntrospectionScope {
  requiredSchemas: readonly string[] | null;
  catalogTypes: ScopedCatalogTypes | null;
}

export interface IntrospectionQueryPlan extends IntrospectionScope {
  query: { text: string; values?: unknown[] };
}

export function getIntrospectionQuery(
  pgService: GraphileConfig.PgServiceConfiguration,
  config?: PgScopedIntrospectionServiceConfig,
): IntrospectionQueryPlan {
  if (!config) {
    return {
      query: { text: makeIntrospectionQuery() },
      requiredSchemas: null,
      catalogTypes: null,
    };
  }

  const options = config === true ? {} : config;

  const requiredSchemas = pgService.schemas ?? [];
  const catalogTypes = options.catalogTypes ?? "all";

  return {
    query: makeSchemaScopedIntrospectionQuery(requiredSchemas, {
      catalogTypes,
      capabilityExtensions: options.capabilityExtensions ?? [],
    }),
    requiredSchemas,
    catalogTypes,
  };
}

export function assertScopedIntrospectionServices(
  pgServices: ReadonlyArray<GraphileConfig.PgServiceConfiguration> | undefined,
  options: GraphileBuild.GatherOptions["pgScopedIntrospection"],
): void {
  if (!options) return;

  const serviceNames = new Set(
    (pgServices ?? []).map((pgService) => pgService.name),
  );
  const unknownServiceNames = Object.keys(options).filter(
    (serviceName) => !serviceNames.has(serviceName),
  );
  if (unknownServiceNames.length > 0) {
    throw new Error(
      `Schema-scoped introspection configured for unknown PostgreSQL service(s): ${unknownServiceNames.join(
        ", ",
      )}`,
    );
  }
}

export function assertScopedNamespaces(
  introspection: Introspection,
  requiredSchemas: readonly string[] | null,
  serviceName: string,
): void {
  if (requiredSchemas === null) return;

  const found = new Set(
    introspection.namespaces.map((namespace) => namespace.nspname),
  );
  const missing = requiredSchemas.filter((schema) => !found.has(schema));
  if (missing.length > 0) {
    throw new Error(
      `Schema-scoped introspection for service '${serviceName}' did not find required schema(s): ${missing.join(
        ", ",
      )}`,
    );
  }
}

export function assertDependencyClosureTypes(
  introspection: Introspection,
  catalogTypes: ScopedCatalogTypes | null,
  serviceName: string,
): void {
  if (catalogTypes !== "dependency-closure") return;

  const retainedTypeOids = new Set(introspection.types.map((type) => type._id));
  const requireType = (
    oid: string | null | undefined,
    objectKind: string,
    objectContext: string,
    field: string,
  ): void => {
    if (oid === null || oid === undefined || oid === "0") return;
    // Extension-owned composite resources are removed from the public arrays
    // after lookup hydration; the lookup remains available to consumers.
    const introspectionLookups = (
      introspection as Introspection & {
        _lookups: { typeById: Map<string, unknown> };
      }
    )._lookups;
    const resolves =
      retainedTypeOids.has(oid) || introspectionLookups.typeById.has(oid);
    if (!resolves) {
      throw new Error(
        `Dependency-closure introspection for service '${serviceName}' retained ${objectKind} '${objectContext}' field '${field}' referencing missing pg_type OID '${oid}'`,
      );
    }
  };
  const requireTypes = (
    oids: readonly string[] | null | undefined,
    objectKind: string,
    objectContext: string,
    field: string,
  ): void => {
    for (const oid of oids ?? []) {
      requireType(oid, objectKind, objectContext, field);
    }
  };

  for (const entity of introspection.classes) {
    const context = `${entity.relname} (${entity._id})`;
    requireType(entity.reltype, "pg_class", context, "reltype");
    requireType(entity.reloftype, "pg_class", context, "reloftype");
  }
  for (const entity of introspection.attributes) {
    requireType(
      entity.atttypid,
      "pg_attribute",
      `${entity.attrelid}.${entity.attname}`,
      "atttypid",
    );
  }
  for (const entity of introspection.constraints) {
    requireType(
      entity.contypid,
      "pg_constraint",
      `${entity.conname} (${entity._id})`,
      "contypid",
    );
  }
  for (const entity of introspection.procs) {
    const context = `${entity.proname} (${entity._id})`;
    requireType(entity.prorettype, "pg_proc", context, "prorettype");
    requireTypes(entity.proargtypes, "pg_proc", context, "proargtypes");
    requireTypes(entity.proallargtypes, "pg_proc", context, "proallargtypes");
  }
  for (const entity of introspection.types) {
    const context = `${entity.typname} (${entity._id})`;
    requireType(entity.typbasetype, "pg_type", context, "typbasetype");
    requireType(entity.typelem, "pg_type", context, "typelem");
    requireType(entity.typarray, "pg_type", context, "typarray");
  }
  for (const entity of introspection.enums) {
    requireType(
      entity.enumtypid,
      "pg_enum",
      `${entity.enumlabel} (${entity._id})`,
      "enumtypid",
    );
  }
  for (const entity of introspection.ranges) {
    const context = `range ${entity.rngtypid ?? "unknown"}`;
    requireType(entity.rngtypid, "pg_range", context, "rngtypid");
    requireType(entity.rngsubtype, "pg_range", context, "rngsubtype");
    requireType(entity.rngmultitypid, "pg_range", context, "rngmultitypid");
  }
}
