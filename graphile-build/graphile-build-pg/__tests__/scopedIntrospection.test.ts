import { gather } from "graphile-build";
import type { SchemaScopedIntrospectionOptions } from "pg-introspection";
import { makeIntrospectionQuery } from "pg-introspection";

import { PgIntrospectionPlugin } from "../src/index.ts";

interface IntrospectionQuery {
  text: string;
  values?: unknown[];
}

type ServiceConfig = boolean | SchemaScopedIntrospectionOptions;

async function captureIntrospectionQuery(
  configByService?: Readonly<Record<string, ServiceConfig>>,
): Promise<IntrospectionQuery> {
  let capturedQuery: IntrospectionQuery | undefined;
  const queryCaptured = new Error("query captured");
  const pgService = {
    name: "main",
    schemas: ["app_public"],
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
});
