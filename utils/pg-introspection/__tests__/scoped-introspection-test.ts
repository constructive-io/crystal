import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  makeIntrospectionQuery,
  makeSchemaScopedIntrospectionQuery,
} from "../src/index.ts";

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
});
