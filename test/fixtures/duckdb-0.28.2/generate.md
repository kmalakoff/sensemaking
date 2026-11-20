# duckdb-0.28.2 fixture

A two-note tree and the duckdb index that the released `sensemaking@0.28.2` built for it, under `@duckdb/node-api@1.5.6-r.2` (DuckDB `v1.5.6`). `duckdb-engine-versions.test.ts` opens it with the current code on DuckDB 2.0 and on 1.5.6-r.1.

This is a change detector for upgrades, not an oracle: it pins the file layout and `meta` rows that 0.28.2 wrote. Current code cannot regenerate it; only the released 0.28.2 can.

## Regenerate

In an empty scratch folder (not inside a sensemaking checkout):

```sh
cp one.md two.md sense.config.json <scratch>/
cd <scratch>
npx sensemaking@0.28.2 build
gzip -9 -n -c .sense/cache.duckdb > cache.duckdb.gz
```

`one.md` and `two.md` are copied from this folder; `sense.config.json` is the file 0.28.2 rewrote on its first run (config version 4 migrated to 6). The first build installs `@duckdb/node-api@^1.5.6-r.1` into `~/.iml`, which resolved to `1.5.6-r.2`.

## Identity

- `meta.engine_identity`: `@duckdb/node-api@1.5.6-r.2`
- `meta.schema_version`: `6`
- `select version()`: `v1.5.6`
- uncompressed `cache.duckdb` sha256: `de5706c147383fc4c59d32650ffa7ea809d90adf1573f48ec8229a80ea8ed2a6` (4,993,024 bytes)

## sha256 of the committed files

```
08469dcb60d0e368322f52dab40271630d5debe56c1cecc631406bd871a7fbc9  cache.duckdb.gz
030ee9818c22a081ed97c73d5a11bbbd4df37df7587bd8748d23fd209daaf72a  one.md
898ca41ccaec5dd94de2f19239ac5e6bc298f980310554212ec1f2c410d73084  sense.config.json
415f9220f29eb4c4c5fee69c75aafb113e5779904cebf33c2409eb77c2052d4f  two.md
```

`sense.config.json` is the JSON 0.28.2 wrote, reformatted by `tsds validate`'s biome.

Built with Node 26.13.1 and npm 11.20.0 on macOS arm64.
