import { makeIntrospectionQuery } from "pg-introspection";

import {
  assertScopedIntrospectionServices,
  getIntrospectionQuery,
} from "../src/scopedIntrospection.ts";

const makeService = (
  options: Partial<GraphileConfig.PgServiceConfiguration> = {},
): GraphileConfig.PgServiceConfiguration =>
  ({
    name: "main",
    schemas: ["app_public"],
    ...options,
  }) as GraphileConfig.PgServiceConfiguration;

describe("scoped introspection service configuration", () => {
  it("uses stock introspection unless explicitly enabled", () => {
    const plan = getIntrospectionQuery(makeService());

    expect(plan).toEqual({
      query: { text: makeIntrospectionQuery() },
      requiredSchemas: null,
      allowedSchemas: null,
      catalogTypes: null,
    });
  });

  it("builds a scoped, parameterized query from the service schemas", () => {
    const plan = getIntrospectionQuery(makeService(), {
      allowedDependencySchemas: ["app_private"],
      catalogTypes: "dependency-closure",
      capabilityExtensions: ["pg_trgm"],
    });

    expect(plan.query.values).toEqual([["app_public"], ["pg_trgm"]]);
    expect(plan.requiredSchemas).toEqual(["app_public"]);
    expect(plan.allowedSchemas).toEqual([
      "app_public",
      "app_private",
      "pg_catalog",
    ]);
    expect(plan.catalogTypes).toBe("dependency-closure");
  });

  it("rejects configuration for an unknown PostgreSQL service", () => {
    expect(() =>
      assertScopedIntrospectionServices([makeService()], {
        analytics: {},
      }),
    ).toThrow(/unknown PostgreSQL service\(s\): analytics/);
  });

  it.each([
    ["", /exact non-empty schema names/],
    [" app_private", /exact non-empty schema names/],
    ["pg_catalog", /must not be a system schema/],
    ["app\0private", /must not contain NUL bytes/],
  ])("rejects invalid dependency schema %p", (schema, expected) => {
    expect(() =>
      getIntrospectionQuery(makeService(), {
        allowedDependencySchemas: [schema],
      }),
    ).toThrow(expected);
  });
});
