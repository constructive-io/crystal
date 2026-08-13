import { GraphQLSchema, graphqlSync } from "grafast/graphql";
import {
  buildSchema,
  defaultPreset,
  QueryPlugin,
  QueryQueryPlugin,
} from "graphile-build";

declare global {
  namespace GraphileConfig {
    interface Plugins {
      AfterSchemaValidationTestPlugin: true;
      InvalidAfterSchemaValidationTestPlugin: true;
    }
  }
}

const schemaPlugins = [QueryPlugin, QueryQueryPlugin];

function makeLifecyclePlugin(
  register: (build: GraphileBuild.Build) => void,
  finalize?: () => void,
): GraphileConfig.Plugin {
  return {
    name: "AfterSchemaValidationTestPlugin",
    schema: {
      hooks: {
        build(build) {
          register(build as GraphileBuild.Build);
          return build;
        },
        ...(finalize
          ? {
              finalize(schema) {
                finalize();
                return schema;
              },
            }
          : null),
      },
    },
  };
}

test("schema construction is unchanged when no callback is registered", () => {
  const schema = buildSchema({ plugins: schemaPlugins }, {});

  expect(
    graphqlSync({
      schema,
      source: "{ __typename }",
    }),
  ).toEqual({ data: { __typename: "Query" } });
  expect(defaultPreset.plugins).toEqual(
    expect.not.arrayContaining([
      expect.objectContaining({ name: "AfterSchemaValidationTestPlugin" }),
    ]),
  );
});

test("runs a callback once after schema finalization and validation", () => {
  const calls: string[] = [];

  buildSchema(
    {
      plugins: [
        ...schemaPlugins,
        makeLifecyclePlugin(
          (build) => {
            build.registerAfterSchemaValidation(() => calls.push("callback"));
          },
          () => calls.push("finalize"),
        ),
      ],
    },
    {},
  );

  expect(calls).toEqual(["finalize", "callback"]);
});

test("does not run callbacks when schema validation fails", () => {
  const callback = jest.fn();
  const InvalidSchemaPlugin: GraphileConfig.Plugin = {
    name: "InvalidAfterSchemaValidationTestPlugin",
    schema: {
      hooks: {
        finalize() {
          return new GraphQLSchema({});
        },
      },
    },
  };

  expect(() =>
    buildSchema(
      {
        plugins: [
          ...schemaPlugins,
          makeLifecyclePlugin((build) => {
            build.registerAfterSchemaValidation(callback);
          }),
          InvalidSchemaPlugin,
        ],
      },
      {},
    ),
  ).toThrow(/validation failure/);
  expect(callback).not.toHaveBeenCalled();
});

test("runs multiple callbacks once in registration order", () => {
  const calls: string[] = [];

  buildSchema(
    {
      plugins: [
        ...schemaPlugins,
        makeLifecyclePlugin((build) => {
          build.registerAfterSchemaValidation(() => calls.push("first"));
          build.registerAfterSchemaValidation(() => calls.push("second"));
        }),
      ],
    },
    {},
  );

  expect(calls).toEqual(["first", "second"]);
});

test("rejects callback registration after the build hook", () => {
  let capturedBuild: GraphileBuild.Build | undefined;

  buildSchema(
    {
      plugins: [
        ...schemaPlugins,
        makeLifecyclePlugin((build) => {
          capturedBuild = build;
        }),
      ],
    },
    {},
  );

  expect(() => capturedBuild?.registerAfterSchemaValidation(() => {})).toThrow(
    "After-schema-validation callbacks may only be registered during the 'build' hook",
  );
});
