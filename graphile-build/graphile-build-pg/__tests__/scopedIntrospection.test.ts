import { gather } from "graphile-build";
import type { SchemaScopedIntrospectionOptions } from "pg-introspection";
import { makeIntrospectionQuery } from "pg-introspection";

import { PgIntrospectionPlugin } from "../src/index.ts";
import { GraphileBuildPgLibPreset } from "../src/preset.ts";

interface IntrospectionQuery {
  text: string;
  values?: unknown[];
}

type ServiceConfig = boolean | SchemaScopedIntrospectionOptions;

async function captureIntrospectionQuery(
  configByService?: Readonly<Record<string, ServiceConfig>>,
  {
    serviceName = "main",
    schemas = ["app_public"],
    onQuery,
  }: {
    serviceName?: string;
    schemas?: string[];
    onQuery?: (query: IntrospectionQuery) => void;
  } = {},
): Promise<IntrospectionQuery> {
  let capturedQuery: IntrospectionQuery | undefined;
  const queryCaptured = new Error("query captured");
  const pgService = {
    name: serviceName,
    schemas,
    withPgClientKey: "withPgClient",
    pgSettingsKey: "pgSettings",
    adaptorSettings: {},
    adaptor: {
      createWithPgClient() {
        return async (
          _pgSettings: Record<string, string | undefined> | null,
          callback: (client: never) => Promise<unknown>,
        ) =>
          callback({
            query(query: IntrospectionQuery) {
              onQuery?.(query);
              capturedQuery = query;
              throw queryCaptured;
            },
          } as never);
      },
    },
  } as GraphileConfig.PgServiceConfiguration;
  const IntrospectionConsumerPlugin: GraphileConfig.Plugin = {
    name: "IntrospectionConsumerPlugin",
    after: ["PgIntrospectionPlugin"],
    gather: {
      async main(_output, info) {
        await info.helpers.pgIntrospection.getIntrospection();
      },
    },
  };

  try {
    await gather({
      extends: [GraphileBuildPgLibPreset],
      plugins: [PgIntrospectionPlugin, IntrospectionConsumerPlugin],
      pgServices: [pgService],
      ...(configByService
        ? { gather: { pgScopedIntrospection: configByService } }
        : null),
    });
  } catch (error) {
    if (error !== queryCaptured) throw error;
  }

  if (!capturedQuery) {
    throw new Error("PostgreSQL introspection query was not executed");
  }
  return capturedQuery;
}

describe("scoped introspection service configuration", () => {
  it.each([undefined, false])(
    "uses stock introspection for %p",
    async (config) => {
      await expect(
        captureIntrospectionQuery(
          config === undefined ? undefined : { main: config },
        ),
      ).resolves.toEqual({ text: makeIntrospectionQuery() });
    },
  );

  it("uses scoped introspection defaults for true", async () => {
    const query = await captureIntrospectionQuery({ main: true });

    expect(query.values).toEqual([["app_public"], []]);
  });

  it("builds a scoped, parameterized query from the service schemas", async () => {
    const query = await captureIntrospectionQuery({
      main: {
        catalogTypes: "dependency-closure",
        capabilityExtensions: ["pg_trgm"],
      },
    });

    expect(query.text).not.toContain(
      "or pg_type.typnamespace = 'pg_catalog'::regnamespace",
    );
    expect(query.values).toEqual([["app_public"], ["pg_trgm"]]);
  });

  it("rejects configuration for an unknown PostgreSQL service", async () => {
    await expect(captureIntrospectionQuery({ analytics: {} })).rejects.toThrow(
      /unknown PostgreSQL service\(s\): analytics/u,
    );
  });

  it.each([
    {
      schemas: [],
      config: true,
      reason: "Schema-scoped introspection requires at least one schema",
    },
    {
      schemas: ["pg_catalog"],
      config: true,
      reason:
        "Schema-scoped introspection cannot expose system schema 'pg_catalog'",
    },
    {
      schemas: ["app_public"],
      config: JSON.parse('{"catalogTypes":"dependancy-closure"}'),
      reason:
        'Schema-scoped introspection catalogTypes must be "all" or "dependency-closure"; received \'dependancy-closure\'',
    },
  ])(
    "identifies the service when plan construction fails: $reason",
    async ({ schemas, config, reason }) => {
      const onQuery = jest.fn();
      await expect(
        captureIntrospectionQuery(
          { analytics: config },
          { serviceName: "analytics", schemas, onQuery },
        ),
      ).rejects.toMatchObject({
        message: `Schema-scoped introspection plan construction failed for PostgreSQL service 'analytics': ${reason}`,
        cause: expect.objectContaining({ message: reason }),
      });
      expect(onQuery).not.toHaveBeenCalled();
    },
  );
});
