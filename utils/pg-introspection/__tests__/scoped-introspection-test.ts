import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  type Introspection,
  makeIntrospectionQuery,
  makeSchemaScopedIntrospectionPlan,
  makeSchemaScopedIntrospectionQuery,
  validateSchemaScopedIntrospection,
} from "../src/index.ts";

function makeIntrospection(
  overrides: Partial<Introspection> = {},
  lookupTypeOids: readonly string[] = [],
): Introspection {
  return {
    namespaces: [],
    classes: [],
    attributes: [],
    constraints: [],
    procs: [],
    types: [],
    enums: [],
    ranges: [],
    _lookups: {
      typeById: new Map(lookupTypeOids.map((oid) => [oid, {}])),
    },
    ...overrides,
  } as unknown as Introspection;
}

describe("schema-scoped introspection query", () => {
  it("does not change the stock introspection query", () => {
    // Exact query hash from before buildIntrospectionQuery was introduced.
    const hash = createHash("sha256")
      .update(makeIntrospectionQuery())
      .digest("hex");
    assert.equal(
      hash,
      "c0ed817b912f78e1ea68c70d89ff4b7f9cb4c02d88112a69ac4109d5b996e4c5",
    );
  });

  it("keeps schema and extension names in query parameters", () => {
    const schema = "tenant_a'); drop schema public; --";
    const extension = "pg_trgm'); select pg_sleep(10); --";
    const query = makeSchemaScopedIntrospectionQuery(
      [schema, "tenant_a", schema],
      { capabilityExtensions: [extension, "pg_trgm", extension] },
    );

    assert.match(query.text, /pg_catalog\.unnest\(\$1::text\[\]\)/);
    assert.match(query.text, /pg_catalog\.unnest\(\$2::text\[\]\)/);
    assert.equal(query.text.includes(schema), false);
    assert.equal(query.text.includes(extension), false);
    assert.deepEqual(query.values, [
      [schema, "tenant_a"],
      [extension, "pg_trgm"],
    ]);
  });

  it("rejects invalid schema and extension names", () => {
    assert.throws(
      () => makeSchemaScopedIntrospectionQuery([]),
      /requires at least one schema/,
    );
    assert.throws(
      () => makeSchemaScopedIntrospectionQuery(["pg_catalog"]),
      /cannot expose system schema 'pg_catalog'/,
    );
    assert.throws(
      () => makeSchemaScopedIntrospectionQuery(["information_schema"]),
      /cannot expose system schema 'information_schema'/,
    );
    assert.throws(
      () => makeSchemaScopedIntrospectionQuery(["tenant\0a"]),
      /must not contain NUL bytes/,
    );
    assert.throws(
      () =>
        makeSchemaScopedIntrospectionQuery(["tenant_a"], {
          capabilityExtensions: [" pg_trgm"],
        }),
      /must contain exact non-empty extension names/,
    );
  });

  it("supports full and dependency-closure catalog type policies", () => {
    const all = makeSchemaScopedIntrospectionQuery(["tenant_a"]);
    const closure = makeSchemaScopedIntrospectionQuery(["tenant_a"], {
      catalogTypes: "dependency-closure",
    });

    for (const query of [all, closure]) {
      assert.match(query.text, /with\nrecursive/u);
      assert.match(query.text, /object_closure\(object_class, object_id\) as/u);
      assert.match(query.text, /retained_index_support_objects/u);
      assert.match(query.text, /installed_extensions/u);
    }
    assert.match(
      all.text,
      /or pg_type\.typnamespace = 'pg_catalog'::regnamespace/u,
    );
    assert.doesNotMatch(
      closure.text,
      /or pg_type\.typnamespace = 'pg_catalog'::regnamespace/u,
    );
  });

  it("shares normalized scope data between query and validation", () => {
    const plan = makeSchemaScopedIntrospectionPlan(
      ["app_public", "app_public"],
      {
        catalogTypes: "dependency-closure",
        capabilityExtensions: ["pg_trgm", "pg_trgm"],
      },
    );

    assert.deepEqual(plan.scope, {
      schemas: ["app_public"],
      catalogTypes: "dependency-closure",
      capabilityExtensions: ["pg_trgm"],
    });
    assert.equal(plan.query.values[0], plan.scope.schemas);
    assert.equal(plan.query.values[1], plan.scope.capabilityExtensions);
  });

  it("fails fast when a required root schema is missing", () => {
    const plan = makeSchemaScopedIntrospectionPlan(["app_public"]);

    assert.throws(
      () => validateSchemaScopedIntrospection(makeIntrospection(), plan),
      /did not find required schema\(s\): app_public/u,
    );
  });

  it("fails fast when a function dependency type is missing", () => {
    const plan = makeSchemaScopedIntrospectionPlan(["app_public"], {
      catalogTypes: "dependency-closure",
    });
    const introspection = makeIntrospection({
      namespaces: [{ nspname: "app_public" }] as Introspection["namespaces"],
      procs: [
        {
          _id: "20",
          proname: "missing_result",
          prorettype: "999",
          proargtypes: [],
          proallargtypes: null,
        },
      ] as Introspection["procs"],
    });

    assert.throws(
      () => validateSchemaScopedIntrospection(introspection, plan),
      /pg_proc.*prorettype.*missing pg_type OID '999'/u,
    );
  });

  it("fails fast on a dangling column type", () => {
    const plan = makeSchemaScopedIntrospectionPlan(["app_public"], {
      catalogTypes: "dependency-closure",
    });
    const introspection = makeIntrospection({
      namespaces: [{ nspname: "app_public" }] as Introspection["namespaces"],
      attributes: [
        {
          attrelid: "10",
          attname: "dangling_value",
          atttypid: "999",
        },
      ] as Introspection["attributes"],
    });

    assert.throws(
      () => validateSchemaScopedIntrospection(introspection, plan),
      /pg_attribute.*atttypid.*missing pg_type OID '999'/u,
    );
  });

  it("accepts dependency types retained in internal lookups", () => {
    const plan = makeSchemaScopedIntrospectionPlan(["app_public"], {
      catalogTypes: "dependency-closure",
    });
    const introspection = makeIntrospection(
      {
        namespaces: [{ nspname: "app_public" }] as Introspection["namespaces"],
        attributes: [
          {
            attrelid: "10",
            attname: "extension_value",
            atttypid: "999",
          },
        ] as Introspection["attributes"],
      },
      ["999"],
    );

    assert.doesNotThrow(() =>
      validateSchemaScopedIntrospection(introspection, plan),
    );
  });
});
