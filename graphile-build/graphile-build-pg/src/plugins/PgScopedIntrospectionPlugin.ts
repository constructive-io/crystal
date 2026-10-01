import type {
  SchemaScopedIntrospectionOptions,
  SchemaScopedIntrospectionPlan,
} from "pg-introspection";
import {
  makeSchemaScopedIntrospectionPlan,
  validateSchemaScopedIntrospection,
} from "pg-introspection";

import { version } from "../version.ts";

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

  namespace GraphileConfig {
    interface Plugins {
      PgScopedIntrospectionPlugin: true;
    }
  }
}

export type PgScopedIntrospectionOptions = SchemaScopedIntrospectionOptions;

export type PgScopedIntrospectionServiceConfig =
  | boolean
  | PgScopedIntrospectionOptions;

function getOptions(
  config: PgScopedIntrospectionServiceConfig | undefined,
): PgScopedIntrospectionOptions | null {
  if (!config) return null;
  return config === true ? {} : config;
}

const plansByQuery = new WeakMap<object, SchemaScopedIntrospectionPlan>();

function assertScopedIntrospectionServices(
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

export const PgScopedIntrospectionPlugin: GraphileConfig.Plugin = {
  name: "PgScopedIntrospectionPlugin",
  description:
    "Replaces PostgreSQL introspection queries with schema-scoped queries when configured",
  version,
  before: ["PgIntrospectionPlugin"],

  gather: {
    main(_output, info) {
      assertScopedIntrospectionServices(
        info.resolvedPreset.pgServices,
        info.options.pgScopedIntrospection,
      );
      return Promise.resolve();
    },

    hooks: {
      pgIntrospection_query(info, event) {
        const options = getOptions(
          info.options.pgScopedIntrospection?.[event.pgService.name],
        );
        if (!options) return;

        let plan: SchemaScopedIntrospectionPlan;
        try {
          plan = makeSchemaScopedIntrospectionPlan(
            event.pgService.schemas ?? [],
            {
              catalogTypes: options.catalogTypes,
              capabilityExtensions: options.capabilityExtensions,
            },
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `Schema-scoped introspection plan construction failed for PostgreSQL service '${event.pgService.name}': ${message}`,
            { cause: error },
          );
        }
        plansByQuery.set(plan.query, plan);
        event.query = plan.query;
      },

      pgIntrospection_introspection(_info, event) {
        const plan = plansByQuery.get(event.query);
        if (!plan) return;

        try {
          validateSchemaScopedIntrospection(event.introspection, plan);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `Schema-scoped introspection validation failed for PostgreSQL service '${event.serviceName}': ${message}`,
          );
        }
      },
    },
  },
};

export const PgScopedIntrospectionPreset: GraphileConfig.Preset = {
  plugins: [PgScopedIntrospectionPlugin],
};
