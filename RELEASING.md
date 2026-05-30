# Releasing

Maintainer notes for publishing to npm so users can run `npx -y meticulous-mcp-server`.

```bash
npm whoami                          # confirm logged in
npm ci && npm run build             # clean build
npm version patch                   # bump version
npm publish --access public         # publish
npx -y meticulous-mcp-server        # smoke test
```

Until published to npm, the install path in the README uses the GitHub source
directly (`github:erdos2n/meticulous-mcp-server`), which requires no release step.
