# graphile-build-pg

[![GitHub Sponsors](https://img.shields.io/github/sponsors/benjie?color=ff69b4&label=github%20sponsors)](https://github.com/sponsors/benjie)
[![Discord chat room](https://img.shields.io/discord/489127045289476126.svg)](http://discord.gg/graphile)
[![Follow](https://img.shields.io/badge/BSky-@Graphile.org-006aff.svg)](https://bsky.app/profile/graphile.org)
[![Follow](https://img.shields.io/badge/Mastodon-@Graphile.fosstodon.org-6364ff.svg)](https://fosstodon.org/@graphile)

`graphile-build-pg` is a collection of [graphile-build][] plugins that extend
your GraphQL schema with types and fields based on the tables, views, functions
and other resources in your PostgreSQL database.

This is achieved by introspecting your database with [pg-introspection][] and
then building a [@dataplan/pg][] registry (composed of codecs, resources and
relations) for these entities. Then our plugins inspect this registry and
creates the relevant GraphQL types, fields, and [grafast][] plan resolver
functions. The result is a high-performance, powerful, auto-generated but highly
flexible GraphQL schema.

## Schema-scoped introspection

PostgreSQL services can opt into schema-scoped introspection through gather
options keyed by service name. Use `true` to enable it with defaults, `false` to
explicitly disable it, or an options object to customize it. Services without an
entry continue to use the full catalog query.

```ts
const preset = {
  // ...
  gather: {
    pgScopedIntrospection: {
      main: true,
    },
  },
};
```

For advanced configuration:

```ts
const preset = {
  pgServices: [
    makePgService({
      name: "main",
      connectionString: process.env.DATABASE_URL,
      schemas: ["app_public"],
    }),
  ],
  gather: {
    pgScopedIntrospection: {
      main: {
        catalogTypes: "dependency-closure" as const,
        capabilityExtensions: ["pg_trgm"],
      },
    },
  },
};
```

The service's `schemas` are the roots of the introspection query. Referenced
objects in other schemas are discovered and retained automatically, while
unrelated objects are excluded. Configuration for an unknown service name fails
rather than being silently ignored.

Extensions required by retained objects, such as the operator class behind a
`pg_trgm` index, are discovered automatically. `capabilityExtensions` is for a
different case: it retains lightweight metadata proving that an extension is
installed even when no retained object directly depends on it. For example, a
plugin can check for `pg_trgm` before exposing an optional search capability. It
does not install the extension or retain every object owned by it.

If you don't want to use your database introspection results to generate the
schema, you can instead build the registry yourself giving you full control over
what goes into your GraphQL API whilst still saving you significant effort
versus writing the schema without auto-generation.

`graphile-build-pg` is a core component of [PostGraphile][], a library that
helps you craft your ideal, incredibly performant, best practices GraphQL API
backed primarily by a PostgreSQL database with minimal developer effort.

<!-- SPONSORS_BEGIN -->

## Crowd-funded open-source software

To help us develop this software sustainably, we ask all individuals and
businesses that use it to help support its ongoing maintenance and development
via sponsorship.

### [Click here to find out more about sponsors and sponsorship.](https://www.graphile.org/sponsor/)

And please give some love to our featured sponsors 🤩:

<table><tr>
<td align="center"><a href="https://gosteelhead.com/"><img src="https://graphile.org/images/sponsors/steelhead.svg" width="90" height="90" alt="Steelhead" /><br />Steelhead</a> *</td>
</tr></table>

<em>\* Sponsors the entire Graphile suite</em>

<!-- SPONSORS_END -->

## About

Thanks to Gra*fast*'s query planning capabilities, the plugins in this package
do not exhibit the N+1 query problem common in many database-based GraphQL APIs;
for all but the flattest GraphQL queries these plugins typically significantly
outperform `DataLoader`-based solutions - and the more complex your GraphQL
query becomes the greater the benefit.

[postgraphile]: https://postgraphile.org
[graphile-build]: https://npmjs.com/package/graphile-build
[grafast]: https://grafast.org
[pg-introspection]: https://npmjs.com/package/pg-introspection
[@dataplan/pg]: https://grafast.org/grafast/step-library/dataplan-pg/
