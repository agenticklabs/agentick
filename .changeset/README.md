# Changesets

This directory is used by [Changesets](https://github.com/changesets/changesets) to manage versioning and changelogs.

## Adding a changeset

When you make a change that should be released, run:

```bash
pnpm changeset
```

This will prompt you to:

1. Select which packages have changed
2. Choose the bump type (major/minor/patch)
3. Write a summary of the changes

Commit the generated changeset file with your PR.

## Releasing

Releases are automated via GitHub Actions:

1. When PRs with changesets are merged to `master`, a "chore: version packages" PR is automatically created/updated
2. This PR contains all version bumps and changelog updates
3. When you're ready to release, merge the version PR
4. Merging triggers automatic publishing to npm and creates GitHub releases with tags

### Manual commands (for local testing only)

```bash
# Preview version changes locally
pnpm version-packages

# Publish (requires NPM_TOKEN - prefer using CI)
pnpm publish-packages
```

## Versioning guidelines

- **patch**: Bug fixes, documentation, internal changes
- **minor**: New features, non-breaking additions
- **major**: Breaking changes

While in pre-1.0 (`0.x.x`), breaking changes can be minor bumps.
