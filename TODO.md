# TODO

Things to do before publishing publicly.

## Before pushing to GitHub

- [ ] Replace `YOUR_USERNAME` in README.md with your actual GitHub username (two spots in the setup section)
- [ ] Create the GitHub repo and push: `git remote add origin https://github.com/YOUR_USERNAME/meticulous-mcp-server.git && git push -u origin main`

## During local testing week

- [ ] Verify `npm run build` completes cleanly on your machine
- [ ] Test the MCP config in Claude Code (Option B — local path)
- [ ] Test each tool category: machine info, profiles, shot history, AI recipe generation
- [ ] Confirm `generate_recipe` and `tailor_recipe` produce valid profiles that load onto the machine without schema errors
- [ ] Test `analyze_shot_and_suggest` after a real shot
- [ ] Note any broken or missing tools to fix before public release

## Nice-to-haves (post-launch)

- [ ] Publish to npm so the install is `npx meticulous-mcp-server` instead of `npx github:...`
- [ ] Add a `CHANGELOG.md`
- [ ] Consider adding a `--version` flag to the CLI
