# ruflo plugins — setup notes

This repo is wired up for the ruflo Claude Code plugins:

```json
{
  "extraKnownMarketplaces": {
    "ruflo": { "source": { "source": "github", "repo": "ruvnet/ruflo" } }
  },
  "enabledPlugins": {
    "ruflo-console@ruflo": true,
    "ruflo-mods@ruflo": true
  },
  "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }
}
```

`ruflo-mods` uses Claude Code function hooks, which are on by default from Claude Code
`2.1.287`; on `2.1.277`–`2.1.286` the `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` env var above is
what turns them on.

## What this file does and does not do

`extraKnownMarketplaces` + `enabledPlugins` let Claude Code **trust and auto-enable** these plugins
for this project. They do **not** download them. A real Claude Code client still has to fetch the
marketplace and resolve the plugins from `ruvnet/ruflo` on first load.

In a terminal with Claude Code installed:

```sh
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-console@ruflo
/plugin install ruflo-mods@ruflo
/reload-plugins
```

Approve the trust prompt; `/ruflo` becomes available once the console plugin loads. Check the
result with `/plugin` (marketplace + enabled plugins) and `/ruflo` (cockpit).

## Not installed by Jenni's app itself

Nothing in `server.js` or the browser code depends on ruflo. This is developer tooling only —
the app still runs with `npm start` and no extra dependencies.
