## Refreshing cached site/GitHub content (manual, untracked)

Keep generated content out of git. The refresh script writes to an ignored directory by default (`packages/terrarium-client/content-local/`). Run it when you want, review locally, then bundle that directory with the worker on the LLM host.

### One-shot refresh (HTTP crawl)

```bash
python scripts/refresh_content.py \
  --site-root https://mbabbott.com \
  --content-dir packages/terrarium-client/content-local \
  --paths "" blog personal-kb terra terrarium-server dice enchanting oh-hell semantic-search
```

- `--paths` is the allowlist of slugs/paths to fetch; adjust as the site evolves.
- Optional: `GITHUB_TOKEN` env for higher GitHub API limits.
- Optional: `--allowlist repos.txt` to restrict repos (one per line).

### Alternate: file-based cache (if running on the VPS)

```bash
python scripts/refresh_content.py \
  --site-root /var/www/html \
  --content-dir packages/terrarium-client/content-local \
  --max-depth 2
```

### After refresh

1) Inspect `packages/terrarium-client/content-local/` and ensure it looks reasonable (text-only, size caps).
2) Copy/ship that directory to the LLM host alongside the worker deploy (keep it untracked).
3) Restart/rebuild the worker so it reads the new cache.

The live-fetch tool remains available for on-demand freshness, but the cached content should serve most questions quickly and predictably.
