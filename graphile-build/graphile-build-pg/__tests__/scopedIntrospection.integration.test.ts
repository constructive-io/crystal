import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { makePgService } from "@dataplan/pg/adaptors/pg";
import {
  execute,
  type GraphQLSchema,
  lexicographicSortSchema,
  parse,
  printSchema,
} from "grafast/graphql";
import {
  defaultPreset as graphileBuildPreset,
  makeSchema,
} from "graphile-build";
import type { Pool } from "pg";
import pg from "pg";
import type { Introspection } from "pg-introspection";

import {
  createTestDatabase,
  dropTestDatabase,
} from "../../../grafast/dataplan-pg/__tests__/sharedHelpers.ts";
import {
  defaultPreset as graphileBuildPgPreset,
  PgScopedIntrospectionPlugin,
} from "../src/index.ts";

const ROOT_SCHEMA = "scope_root";
const DEPENDENCY_SCHEMA = "scope_dependency";
const UNRELATED_SCHEMA = "scope_unrelated";
const EXTENSION_SCHEMA = "scope_extension";
const CAPABILITY_ROOT_SCHEMA = "scope_capability_root";

interface SchemaBuild {
  schema: GraphQLSchema;
  introspection: Introspection;
  hash: string;
}

const makeCapturePlugin = (
  capture: (introspection: Introspection) => void,
): GraphileConfig.Plugin => ({
  name: "ScopedIntrospectionCapturePlugin",
  gather: {
    namespace: "scopedIntrospectionCapture",
    hooks: {
      pgIntrospection_introspection(_info, event) {
        capture(event.introspection);
      },
    },
  },
});

const buildSchema = async (
  pool: Pool,
  scoped: boolean,
  rootSchema = ROOT_SCHEMA,
): Promise<SchemaBuild> => {
  let introspection: Introspection | undefined;
  const service = makePgService({
    pool,
    schemas: [rootSchema],
    pubsub: false,
  });

  try {
    const result = await makeSchema({
      extends: [graphileBuildPreset, graphileBuildPgPreset],
      disablePlugins: ["PgEnumTablesPlugin"],
      ...(scoped
        ? {
            gather: {
              pgScopedIntrospection: {
                [service.name]: {
                  catalogTypes: "dependency-closure" as const,
                  capabilityExtensions: ["pg_trgm"],
                },
              },
            },
          }
        : null),
      plugins: [
        ...(scoped ? [PgScopedIntrospectionPlugin] : []),
        makeCapturePlugin((value) => {
          introspection = value;
        }),
      ],
      pgServices: [service],
    });
    if (!introspection) {
      throw new Error(
        "PostgreSQL introspection lifecycle event was not emitted",
      );
    }
    const sdl = printSchema(lexicographicSortSchema(result.schema));
    return {
      schema: result.schema,
      introspection,
      hash: createHash("sha256").update(sdl).digest("hex"),
    };
  } finally {
    await service.release?.();
  }
};

describe("schema-scoped PostgreSQL introspection", () => {
  let databaseName = "";
  let pool: Pool;
  let stock: SchemaBuild;
  let scoped: SchemaBuild;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    databaseName = testDatabase.databaseName;
    pool = new pg.Pool({ connectionString: testDatabase.connectionString });
    const fixture = await readFile(
      join(__dirname, "fixtures/scoped-introspection.sql"),
      "utf8",
    );
    await pool.query(fixture);
    stock = await buildSchema(pool, false);
    scoped = await buildSchema(pool, true);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await dropTestDatabase(databaseName);
  });

  it("builds the same schema and a working runtime", async () => {
    expect(scoped.hash).toBe(stock.hash);

    const document = parse("{ __typename }");
    const stockResult = await execute({ schema: stock.schema, document });
    const scopedResult = await execute({ schema: scoped.schema, document });
    expect(scopedResult).toEqual(stockResult);
    expect(scopedResult.errors).toBeUndefined();
    expect(scopedResult.data?.__typename).toBe("Query");
  });

  it("retains transitive table, function, and range type dependencies", () => {
    const namespaceNames = scoped.introspection.namespaces.map(
      (namespace) => namespace.nspname,
    );
    expect(namespaceNames).toEqual(
      expect.arrayContaining([
        ROOT_SCHEMA,
        DEPENDENCY_SCHEMA,
        EXTENSION_SCHEMA,
        "pg_catalog",
      ]),
    );
    expect(namespaceNames).not.toContain(UNRELATED_SCHEMA);

    const rootTable = scoped.introspection.classes.find(
      (entity) =>
        entity.relname === "closure_items" &&
        entity.getNamespace()?.nspname === ROOT_SCHEMA,
    );
    expect(rootTable).toBeDefined();
    const attributeTypes = new Map(
      rootTable!
        .getAttributes()
        .map((attribute) => [attribute.attname, attribute.getType()]),
    );
    expect(attributeTypes.get("status")?.typname).toBe("item_status");
    expect(attributeTypes.get("score")?.typname).toBe("positive_integer");
    expect(attributeTypes.get("payload")?.typname).toBe("item_payload");
    expect(attributeTypes.get("active_span")?.typname).toBe("integer_span");

    const statusType = attributeTypes.get("status");
    expect(statusType?.getEnumValues().map((value) => value.enumlabel)).toEqual(
      ["draft", "active", "archived"],
    );
    expect(statusType?.getArrayType()?.typname).toBe("_item_status");

    const payloadType = attributeTypes.get("payload");
    expect(
      payloadType
        ?.getClass()
        ?.getAttributes()
        .map((attribute) => attribute.getType()?.typname),
    ).toEqual(["item_status", "positive_integer"]);

    const echoStatus = scoped.introspection.procs.find(
      (proc) =>
        proc.proname === "echo_dependency_status" &&
        proc.getNamespace()?.nspname === ROOT_SCHEMA,
    );
    expect(echoStatus?.getReturnType()?.typname).toBe("item_status");
    expect(
      echoStatus?.getArguments().map((argument) => argument.type.typname),
    ).toEqual(["item_status"]);

    const makePayload = scoped.introspection.procs.find(
      (proc) =>
        proc.proname === "make_dependency_payload" &&
        proc.getNamespace()?.nspname === ROOT_SCHEMA,
    );
    expect(makePayload?.getReturnType()?.typname).toBe("item_payload");
    expect(
      makePayload?.getArguments().map((argument) => argument.type.typname),
    ).toEqual(["item_status", "positive_integer"]);

    const range = scoped.introspection.ranges.find(
      (entity) => entity.getType()?.typname === "integer_span",
    );
    expect(range?.getSubType()?.typname).toBe("int4");
    expect(
      scoped.introspection.types.find(
        (type) => type._id === range?.rngmultitypid,
      )?.typname,
    ).toBe("integer_span_set");

    const foreignKey = rootTable
      ?.getConstraints()
      .find((constraint) => constraint.contype === "f");
    expect(foreignKey?.getForeignClass()?.relname).toBe("dependency_owners");
    expect(foreignKey?.getForeignClass()?.getNamespace()?.nspname).toBe(
      DEPENDENCY_SCHEMA,
    );

    const inheritedItems = scoped.introspection.classes.find(
      (entity) =>
        entity.relname === "inherited_items" &&
        entity.getNamespace()?.nspname === ROOT_SCHEMA,
    );
    const inherited = inheritedItems?.getInherited();
    expect(inherited).toHaveLength(1);
    expect(
      scoped.introspection.classes.find(
        (entity) => entity._id === inherited?.[0]?.inhparent,
      )?.relname,
    ).toBe("inherited_base");
    expect(
      scoped.introspection.classes.some(
        (entity) => entity.relname === "reverse_inherited_item",
      ),
    ).toBe(false);
  });

  it("retains indexes and identifies their owning extension", () => {
    const indexNames = scoped.introspection.indexes.map(
      (index) => index.getIndexClass()?.relname,
    );
    expect(indexNames).toEqual(
      expect.arrayContaining([
        "closure_items_status_idx",
        "closure_items_title_gin_trgm_idx",
        "closure_items_title_gist_trgm_idx",
      ]),
    );
    expect(
      scoped.introspection.extensions.some(
        (extension) => extension.extname === "pg_trgm",
      ),
    ).toBe(true);
    expect(
      scoped.introspection.types.some(
        (type) => type.getNamespace()?.nspname === UNRELATED_SCHEMA,
      ),
    ).toBe(false);
    expect(
      scoped.introspection.procs.some(
        (proc) => proc.getNamespace()?.nspname === UNRELATED_SCHEMA,
      ),
    ).toBe(false);
  });

  it("retains explicitly requested extension capability metadata", async () => {
    const capabilityOnly = await buildSchema(
      pool,
      true,
      CAPABILITY_ROOT_SCHEMA,
    );

    expect(
      capabilityOnly.introspection.extensions.some(
        (extension) => extension.extname === "pg_trgm",
      ),
    ).toBe(true);
    expect(
      capabilityOnly.introspection.indexes.some((index) =>
        index.getIndexClass()?.relname.includes("trgm"),
      ),
    ).toBe(false);
  });
});
