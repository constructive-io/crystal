import type {
  SchemaScopedIntrospectionOptions,
  SchemaScopedIntrospectionPlan,
} from "pg-introspection";
import {
  makeIntrospectionQuery,
  makeSchemaScopedIntrospectionPlan,
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

export type PgScopedIntrospectionOptions = SchemaScopedIntrospectionOptions;

export type PgScopedIntrospectionServiceConfig =
  | boolean
  | PgScopedIntrospectionOptions;

export interface IntrospectionQueryPlan {
  query: { text: string; values?: unknown[] };
  scopedPlan: SchemaScopedIntrospectionPlan | null;
}

export function getIntrospectionQuery(
  pgService: GraphileConfig.PgServiceConfiguration,
  config?: PgScopedIntrospectionServiceConfig,
): IntrospectionQueryPlan {
  if (!config) {
    return {
      query: { text: makeIntrospectionQuery() },
      scopedPlan: null,
    };
  }

  const options = config === true ? {} : config;
  const scopedPlan = makeSchemaScopedIntrospectionPlan(
    pgService.schemas ?? [],
    options,
  );

  return {
    query: scopedPlan.query,
    scopedPlan,
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
