import { gather } from "graphile-build";
import { makeIntrospectionQuery } from "pg-introspection";

import {
  defaultPreset,
  PgIntrospectionPlugin,
  type PgIntrospectionQuery,
  PgScopedIntrospectionPlugin,
  PgScopedIntrospectionPreset,
  type PgScopedIntrospectionServiceConfig,
} from "../src/index.ts";

interface CaptureOptions {
  config?: PgScopedIntrospectionServiceConfig;
  plugins?: GraphileConfig.Plugin[];
}

async function captureIntrospectionQuery({
  config,
  plugins = [],
}: CaptureOptions = {}): Promise<PgIntrospectionQuery> {
  let capturedQuery: PgIntrospectionQuery | undefined;
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
            query(query: PgIntrospectionQuery) {
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

  await expect(
    gather({
      plugins: [PgIntrospectionPlugin, ...plugins, IntrospectionConsumerPlugin],
      pgServices: [pgService],
      ...(config === undefined
        ? null
        : {
            gather: {
              pgScopedIntrospection: { main: config },
            },
          }),
    }),
  ).rejects.toBe(queryCaptured);
  expect(capturedQuery).toBeDefined();
  return capturedQuery!;
}

describe("PostgreSQL introspection query hook", () => {
  it("uses the stock query when no plugin replaces it", async () => {
    await expect(captureIntrospectionQuery()).resolves.toEqual({
      text: makeIntrospectionQuery(),
    });
  });

  it("allows a gather plugin to replace the query", async () => {
    const ReplacementQueryPlugin: GraphileConfig.Plugin = {
      name: "ReplacementQueryPlugin",
      gather: {
        hooks: {
          pgIntrospection_query(_info, event) {
            event.query = { text: "select $1", values: ["replacement"] };
          },
        },
      },
    };

    await expect(
      captureIntrospectionQuery({ plugins: [ReplacementQueryPlugin] }),
    ).resolves.toEqual({ text: "select $1", values: ["replacement"] });
  });

  it("runs hooks in plugin order and lets the last replacement win", async () => {
    const calls: string[] = [];
    const FirstReplacementPlugin: GraphileConfig.Plugin = {
      name: "FirstReplacementPlugin",
      gather: {
        hooks: {
          pgIntrospection_query(_info, event) {
            calls.push("first");
            event.query = { text: "select 'first'" };
          },
        },
      },
    };
    const SecondReplacementPlugin: GraphileConfig.Plugin = {
      name: "SecondReplacementPlugin",
      gather: {
        hooks: {
          pgIntrospection_query(_info, event) {
            calls.push("second");
            expect(event.query.text).toBe("select 'first'");
            event.query = { text: "select 'second'" };
          },
        },
      },
    };

    await expect(
      captureIntrospectionQuery({
        plugins: [FirstReplacementPlugin, SecondReplacementPlugin],
      }),
    ).resolves.toEqual({ text: "select 'second'" });
    expect(calls).toEqual(["first", "second"]);
  });

  it("ignores scoped configuration when the scoped plugin is not installed", async () => {
    await expect(captureIntrospectionQuery({ config: true })).resolves.toEqual({
      text: makeIntrospectionQuery(),
    });
  });
});

describe("PgScopedIntrospectionPlugin", () => {
  it.each([false, undefined])(
    "uses stock introspection for %p",
    async (config) => {
      await expect(
        captureIntrospectionQuery({
          config,
          plugins: [PgScopedIntrospectionPlugin],
        }),
      ).resolves.toEqual({ text: makeIntrospectionQuery() });
    },
  );

  it("uses scoped defaults for true", async () => {
    const query = await captureIntrospectionQuery({
      config: true,
      plugins: [PgScopedIntrospectionPlugin],
    });

    expect(query.text).toContain("object_closure(object_class, object_id)");
    expect(query.values).toEqual([["app_public"], []]);
  });

  it("passes scoped options to the query builder", async () => {
    const query = await captureIntrospectionQuery({
      config: {
        catalogTypes: "dependency-closure",
        capabilityExtensions: ["pg_trgm"],
      },
      plugins: [PgScopedIntrospectionPlugin],
    });

    expect(query.text).not.toContain(
      "or pg_type.typnamespace = 'pg_catalog'::regnamespace",
    );
    expect(query.values).toEqual([["app_public"], ["pg_trgm"]]);
  });

  it("rejects configuration for an unknown PostgreSQL service", async () => {
    await expect(
      gather({
        plugins: [PgScopedIntrospectionPlugin],
        gather: { pgScopedIntrospection: { analytics: true } },
        pgServices: [],
      }),
    ).rejects.toThrow(/unknown PostgreSQL service\(s\): analytics/);
  });

  it("is opt-in and has a dedicated preset", () => {
    expect(defaultPreset.plugins).not.toContain(PgScopedIntrospectionPlugin);
    expect(PgScopedIntrospectionPreset.plugins).toEqual([
      PgScopedIntrospectionPlugin,
    ]);
  });
});
