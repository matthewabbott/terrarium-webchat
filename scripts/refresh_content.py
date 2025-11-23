"""Refresh cached site and GitHub content for the terrarium worker.

Run manually (no daemons) on the VPS, review the generated files, then
ship them with the worker to the LLM host.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Dict, Iterable, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen


DEFAULT_OWNER = "matthewabbott"
MAX_FILE_BYTES = 100_000
DEFAULT_WEB_PATHS = [
    "",
    "blog",
    "personal-kb",
    "terra",
    "terrarium-server",
    "dice",
    "enchanting",
    "oh-hell",
    "semantic-search",
]


class TextExtractor(HTMLParser):
    """Minimal HTML-to-text extractor (avoids extra dependencies)."""

    def __init__(self) -> None:
        super().__init__()
        self.parts: List[str] = []
        self._skip = False

    def handle_starttag(self, tag: str, attrs: List[tuple[str, str]]) -> None:  # noqa: ARG002
        if tag in {"script", "style"}:
            self._skip = True
        if tag in {"p", "br", "div", "section", "li", "h1", "h2", "h3", "h4"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"}:
            self._skip = False
        if tag in {"p", "div", "section", "li"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip:
            return
        text = data.strip()
        if text:
            self.parts.append(unescape(text) + " ")

    def get_text(self) -> str:
        return "".join(self.parts)


def html_to_text(html: str) -> str:
    parser = TextExtractor()
    parser.feed(html)
    text = parser.get_text()
    collapsed = " ".join(text.split())
    return collapsed.strip()


def fetch_url(url: str, token: Optional[str] = None) -> Optional[bytes]:
    headers = {"User-Agent": "terrarium-cache/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(url, headers=headers)
    try:
        with urlopen(request) as response:  # noqa: S310
            return response.read()
    except HTTPError as exc:
        print(f"  ! Request failed {exc.code} for {url}")
    except URLError as exc:
        print(f"  ! Request failed for {url}: {exc.reason}")
    return None


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    trimmed = content[:MAX_FILE_BYTES]
    path.write_text(trimmed, encoding="utf-8")


def discover_site_files(site_root: Path, max_depth: int = 2) -> List[Path]:
    files: List[Path] = []
    for path in site_root.rglob("*.html"):
        rel = path.relative_to(site_root)
        if len(rel.parts) > max_depth:
            continue
        if rel.name.startswith("index.nginx-debian"):
            continue
        files.append(path)
    return sorted(files)


def slug_for_path(site_root: Path, path: Path) -> str:
    rel = path.relative_to(site_root)
    without_ext = Path(*rel.parts).with_suffix("")
    slug = "-".join(without_ext.parts) or "index"
    return slug.lower()


def slug_for_web_path(path: str) -> str:
    cleaned = path.strip("/")
    if not cleaned:
        return "index"
    # Drop file extensions for simple slugs.
    cleaned = cleaned.split(".")[0]
    return cleaned.replace("/", "-") or "index"


def load_env_token() -> Optional[str]:
    """Prefer GITHUB_TOKEN env; fall back to worker .env if present."""
    token = load_env_token()
    if token:
        return token
    env_path = Path("packages/terrarium-client/.env")
    if not env_path.exists():
        return None
    try:
        for line in env_path.read_text().splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith("GITHUB_TOKEN="):
                _, value = stripped.split("=", 1)
                return value.strip()
    except Exception:
        return None
    return None


def cache_site(site_root: Path | str, content_dir: Path, max_depth: int, web_paths: List[str]) -> Dict[str, str]:
    parsed = urlparse(str(site_root))
    is_url = parsed.scheme in {"http", "https"}
    if is_url:
        return cache_site_from_web(str(site_root), content_dir, web_paths)
    return cache_site_from_files(Path(site_root), content_dir, max_depth)


def cache_site_from_files(site_root: Path, content_dir: Path, max_depth: int) -> Dict[str, str]:
    print(f"Caching site from files at {site_root}")
    pages = discover_site_files(site_root, max_depth=max_depth)
    site_map: List[Dict[str, str]] = []
    for path in pages:
        slug = slug_for_path(site_root, path)
        try:
            html = path.read_text(encoding="utf-8", errors="ignore")
        except Exception as exc:  # noqa: BLE001
            print(f"  ! Skip {path}: {exc}")
            continue
        text = html_to_text(html)
        target = content_dir / f"{slug}.txt"
        write_text(target, text)
        site_map.append({"slug": slug, "path": str(path.relative_to(site_root))})
        print(f"  ✓ {slug} ({path}) -> {target}")

    site_map_path = content_dir / "site_map.json"
    site_map_path.write_text(json.dumps({"sections": site_map}, indent=2), encoding="utf-8")
    print(f"Wrote site_map.json with {len(site_map)} entries")
    return {"site_map": str(site_map_path)}


def cache_site_from_web(base_url: str, content_dir: Path, paths: List[str]) -> Dict[str, str]:
    base_url = normalize_base_url(base_url)
    print(f"Caching site from web at {base_url}")
    site_map: List[Dict[str, str]] = []
    for path in paths:
        slug = slug_for_web_path(path)
        url = urljoin(base_url, path.lstrip("/"))
        raw = fetch_url(url)
        if raw is None:
            print(f"  ! Skip {url}")
            continue
        text = html_to_text(raw.decode("utf-8", errors="ignore"))
        target = content_dir / f"{slug}.txt"
        write_text(target, text)
        site_map.append({"slug": slug, "path": path or "/", "url": url})
        print(f"  ✓ {slug} ({url}) -> {target}")

    site_map_path = content_dir / "site_map.json"
    site_map_path.write_text(json.dumps({"sections": site_map}, indent=2), encoding="utf-8")
    print(f"Wrote site_map.json with {len(site_map)} entries")
    return {"site_map": str(site_map_path)}


def github_request(url: str, token: Optional[str]) -> Optional[bytes]:
    headers = {"Accept": "application/vnd.github.v3+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(url, headers=headers)
    try:
        with urlopen(request) as response:  # noqa: S310 - trusted target
            return response.read()
    except HTTPError as exc:
        print(f"  ! GitHub request failed {exc.code} for {url}")
    except URLError as exc:
        print(f"  ! GitHub request failed for {url}: {exc.reason}")
    return None


@dataclass
class RepoRecord:
    name: str
    description: str
    topics: List[str]
    stars: int
    last_pushed: str
    url: str
    default_branch: str

    def to_dict(self) -> Dict[str, object]:
        return {
            "name": self.name,
            "description": self.description,
            "topics": self.topics,
            "stars": self.stars,
            "last_pushed": self.last_pushed,
            "url": self.url,
            "default_branch": self.default_branch,
        }


def cache_github(owner: str, content_dir: Path, allowlist: Optional[Iterable[str]], token: Optional[str]) -> None:
    repos_url = f"https://api.github.com/users/{owner}/repos?per_page=100&type=owner&sort=updated"
    raw = github_request(repos_url, token)
    if raw is None:
        print("Skipping GitHub cache (no data)")
        return
    repos_data = json.loads(raw.decode("utf-8"))
    allow = {name.lower() for name in allowlist} if allowlist else None

    repos: List[RepoRecord] = []
    github_root = content_dir / "github" / owner
    github_root.mkdir(parents=True, exist_ok=True)

    for item in repos_data:
        if not isinstance(item, dict):
            continue
        name = item.get("name", "").strip()
        if not name:
            continue
        if allow is not None and name.lower() not in allow:
            continue

        repo_record = RepoRecord(
            name=name,
            description=item.get("description") or "",
            topics=item.get("topics") or [],
            stars=int(item.get("stargazers_count") or 0),
            last_pushed=item.get("pushed_at") or "",
            url=item.get("html_url") or "",
            default_branch=item.get("default_branch") or "main",
        )
        repos.append(repo_record)

        readme_url = f"https://api.github.com/repos/{owner}/{name}/readme"
        readme_bytes = github_request(readme_url, token)
        if readme_bytes is None:
            print(f"  ! No README for {name}")
            continue

        # Attempt to decode raw; if it looks like JSON, handle base64 payload.
        content: Optional[str] = None
        try:
            content = readme_bytes.decode("utf-8")
        except UnicodeDecodeError:
            pass

        if content and content.strip().startswith("{"):
            try:
                payload = json.loads(content)
                encoded = payload.get("content")
                if encoded:
                    content = base64.b64decode(encoded).decode("utf-8", errors="ignore")
            except Exception:  # noqa: BLE001 - best effort
                pass
        elif content is None:
            content = readme_bytes.decode("utf-8", errors="ignore")

        target = github_root / name / "README.md"
        write_text(target, content or "")
        print(f"  ✓ Cached README for {name} -> {target}")

    repos_json = content_dir / "github" / "repos.json"
    repos_json.parent.mkdir(parents=True, exist_ok=True)
    repos_json.write_text(json.dumps({"repos": [repo.to_dict() for repo in repos]}, indent=2), encoding="utf-8")
    print(f"Wrote GitHub metadata for {len(repos)} repos -> {repos_json}")


def load_allowlist(path: Optional[str]) -> Optional[List[str]]:
    if not path:
        return None
    allow_path = Path(path)
    if not allow_path.exists():
        print(f"Allowlist file not found: {allow_path}")
        return None
    names = [line.strip() for line in allow_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return names or None


def normalize_base_url(base_url: str) -> str:
    """Ensure base URL has scheme and netloc for urljoin."""
    parsed = urlparse(base_url)
    # Handle cases like "https:/example.com" or missing scheme/netloc
    if parsed.scheme and not parsed.netloc and parsed.path:
        parsed = urlparse(f"{parsed.scheme}://{parsed.path.lstrip('/')}")
    if not parsed.scheme:
        parsed = urlparse(f"https://{base_url.lstrip('/')}")
    if not parsed.netloc:
        raise ValueError(f"Invalid site-root, missing host: {base_url}")
    return urlunparse((parsed.scheme, parsed.netloc, "/", "", "", ""))


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Refresh cached site and GitHub content")
    parser.add_argument("--site-root", default="/var/www/html", help="Root of the deployed site (file path or URL)")
    parser.add_argument(
        "--content-dir",
        type=Path,
        default=Path("packages/terrarium-client/content-local"),
        help="Output directory for cached content",
    )
    parser.add_argument("--owner", default=DEFAULT_OWNER, help="GitHub owner to cache")
    parser.add_argument("--allowlist", help="Optional file with repo names to include (one per line)")
    parser.add_argument("--max-depth", type=int, default=2, help="Max path depth under site-root to cache")
    parser.add_argument(
        "--paths",
        nargs="*",
        default=DEFAULT_WEB_PATHS,
        help="Paths (slugs) to fetch when site-root is a URL",
    )
    args = parser.parse_args(argv)

    content_dir = args.content_dir
    content_dir.mkdir(parents=True, exist_ok=True)

    # Site cache
    cache_site(args.site_root, content_dir, args.max_depth, args.paths)

    # GitHub cache
    token = load_env_token()
    allowlist = load_allowlist(args.allowlist)
    cache_github(args.owner, content_dir, allowlist, token)

    print("Done. Review changes under", content_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
