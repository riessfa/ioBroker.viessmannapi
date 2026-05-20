# Contributing

Thanks for contributing to `ioBroker.viessmannapi`.

## Development workflow

1. Create a topic branch from `master`.
2. Install dependencies with `npm ci`.
3. Make your change in focused commits.
4. Run the local quality checks:
   - `npm run lint`
   - `npm run check`
   - `npm run test`
5. Open a pull request with a short summary, rationale, and test evidence.

## Scope notes

- Version bumps and changelog publication are handled by the release workflow (`.releaseconfig.json`).
- Keep changes backward-compatible with ioBroker adapter conventions where possible.
- Avoid logging secrets or credentials; use the existing safe logging helpers.

## Commit style

Prefer concise, imperative commit messages such as:

- `fix(auth): guard refresh timer scheduling`
- `docs(readme): clarify setup prerequisites`
