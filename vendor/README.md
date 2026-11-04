# Vendored `@solidarity/shared`

A packed copy of `packages/shared` from the sibling `airmeishi` monorepo, for the
reserved-name table (`@solidarity/shared/credsPath`). Same tgz as `airmeishi-web/vendor`.

```sh
cd ../airmeishi/packages/shared && bun pm pack --destination ../../../airmeishi-backend/vendor
cd ../../../airmeishi-backend   # update the filename in package.json if the version bumped
bun install
```
