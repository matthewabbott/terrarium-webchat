"""Tool definitions and lightweight executors for webchat."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, urlparse

import httpx
from html.parser import HTMLParser


ToolDefinition = Dict[str, Any]


class _TextExtractor(HTMLParser):
    """Lightweight HTML-to-text extractor used by live fetch."""

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
            self.parts.append(text + " ")

    def get_text(self) -> str:
        return "".join(self.parts)


def _html_to_text(html: str) -> str:
    parser = _TextExtractor()
    parser.feed(html)
    collapsed = " ".join(parser.get_text().split())
    return collapsed.strip()


TOOL_DEFINITIONS: List[ToolDefinition] = [
    {
        "type": "function",
        "function": {
            "name": "get_site_map",
            "description": "List the key sections and pages available on mbabbott.com.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_site_page",
            "description": "Fetch cached content for a specific site page or section (slug or URL).",
            "parameters": {
                "type": "object",
                "properties": {
                    "slug_or_url": {
                        "type": "string",
                        "description": "Slug like 'projects' or full URL to mbabbott.com content.",
                    }
                },
                "required": ["slug_or_url"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_site",
            "description": "Keyword search over cached mbabbott.com content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Keywords to search for"},
                    "max_results": {"type": "integer", "description": "Max snippets to return", "minimum": 1},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "about_matthew",
            "description": "Structured bio for Matthew Abbott: roles, focus areas, and contact hints.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_projects",
            "description": "List known projects with short blurbs and tags.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_project_details",
            "description": "Fetch structured details for a specific project by name.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Project name or slug to look up."}
                },
                "required": ["name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_web",
            "description": "Run a web search when site context is insufficient.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "max_results": {"type": "integer", "minimum": 1, "maximum": 5},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_github_repos",
            "description": "List cached public GitHub repos for matthewabbott with metadata.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_github_repo",
            "description": "Fetch cached README or a specific cached file from a GitHub repo.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Repository name (without owner)."},
                    "file": {
                        "type": "string",
                        "description": "Optional path within the cached repo (default README.md).",
                    },
                },
                "required": ["name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_github_repos",
            "description": "List cached public GitHub repos for matthewabbott with metadata.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_github_repo",
            "description": "Fetch cached README or a specific cached file from a GitHub repo.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Repository name (without owner)."},
                    "file": {
                        "type": "string",
                        "description": "Optional path within the cached repo (default README.md).",
                    },
                },
                "required": ["name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_live_page",
            "description": "Fetch a live mbabbott.com page (guarded) and return stripped text.",
            "parameters": {
                "type": "object",
                "properties": {
                    "slug_or_url": {
                        "type": "string",
                        "description": "Slug like 'projects' or full mbabbott.com URL.",
                    }
                },
                "required": ["slug_or_url"],
                "additionalProperties": False,
            },
        },
    },
]


@dataclass
class ToolExecutor:
    """Executes webchat tools backed by local cached content."""

    content_dir: Path
    projects_file: Optional[Path] = None
    site_map_file: Optional[Path] = None
    search_api_url: Optional[str] = None
    search_api_key: Optional[str] = None
    github_dir: Path
    github_owner: str = "matthewabbott"
    live_site_base_url: str
    live_allowed_hosts: List[str]

    def __init__(
        self,
        content_dir: Optional[Path] = None,
        projects_file: Optional[Path] = None,
        site_map_file: Optional[Path] = None,
        search_api_url: Optional[str] = None,
        search_api_key: Optional[str] = None,
        github_dir: Optional[Path] = None,
        github_owner: str = "matthewabbott",
        live_site_base_url: Optional[str] = None,
        live_allowed_hosts: Optional[List[str]] = None,
    ) -> None:
        base_dir = Path(__file__).resolve().parent.parent / "content"
        self.content_dir = content_dir or base_dir
        self.projects_file = projects_file
        self.site_map_file = site_map_file
        self.search_api_url = search_api_url or os.environ.get("SEARCH_API_URL")
        self.search_api_key = search_api_key or os.environ.get("SEARCH_API_KEY")
        self.github_dir = github_dir or (self.content_dir / "github")
        self.github_owner = github_owner
        self.live_site_base_url = live_site_base_url or os.environ.get("LIVE_SITE_BASE_URL") or "https://mbabbott.com"
        allowed = live_allowed_hosts or (os.environ.get("LIVE_ALLOWED_HOSTS") or "").split(",")
        default_hosts = ["mbabbott.com", "www.mbabbott.com"]
        self.live_allowed_hosts = [h.strip() for h in allowed if h.strip()] or default_hosts

    async def execute(self, tool_name: str, arguments: Dict[str, Any]) -> str:
        if tool_name == "get_site_map":
            return self._get_site_map()
        if tool_name == "fetch_site_page":
            return self._fetch_site_page(arguments)
        if tool_name == "search_site":
            return self._search_site(arguments)
        if tool_name == "about_matthew":
            return self._about_matthew()
        if tool_name == "list_projects":
            return self._list_projects()
        if tool_name == "get_project_details":
            return self._get_project_details(arguments)
        if tool_name == "search_web":
            return await self._search_web(arguments)
        if tool_name == "list_github_repos":
            return self._list_github_repos()
        if tool_name == "get_github_repo":
            return self._get_github_repo(arguments)
        if tool_name == "fetch_live_page":
            return await self._fetch_live_page(arguments)
        return json.dumps({"error": f"Unknown tool: {tool_name}"})

    def _read_json_file(self, path: Optional[Path]) -> Optional[Dict[str, Any]]:
        if not path:
            return None
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # pragma: no cover - defensive
            return None

    def _get_site_map(self) -> str:
        from_file = self._read_json_file(self.site_map_file)
        default = {"sections": ["home", "projects", "about", "contact"], "note": "Populate site_map.json for real data"}
        return json.dumps(from_file or default)

    def _fetch_site_page(self, arguments: Dict[str, Any]) -> str:
        slug = (arguments.get("slug_or_url") or "").strip().lower()
        if not slug:
            return json.dumps({"error": "slug_or_url is required"})

        sanitized = slug.split("/")[-1] or "index"
        matches = list(self.content_dir.glob(f"{sanitized}.*"))
        if not matches:
            return json.dumps({"error": f"No cached content found for {slug}"})
        try:
            content = matches[0].read_text(encoding="utf-8")
        except Exception as exc:  # pragma: no cover - defensive
            return json.dumps({"error": f"Unable to read cached content: {exc}"})
        return json.dumps({"slug": slug, "content": content[:20_000]})

    def _search_site(self, arguments: Dict[str, Any]) -> str:
        query = (arguments.get("query") or "").strip().lower()
        if not query:
            return json.dumps({"error": "query is required"})
        max_results = int(arguments.get("max_results") or 3)
        snippets: List[Dict[str, str]] = []
        for path in sorted(self.content_dir.glob("*")):
            if len(snippets) >= max_results:
                break
            try:
                text = path.read_text(encoding="utf-8")
            except Exception:
                continue
            if query in text.lower():
                snippet = text[:500].replace("\n", " ")
                snippets.append({"file": path.name, "snippet": snippet})
        if not snippets:
            return json.dumps({"result": "No matches in cached content", "query": query})
        return json.dumps({"query": query, "results": snippets})

    def _about_matthew(self) -> str:
        # Placeholder until real bio content is added.
        return json.dumps(
            {
                "name": "Matthew Abbott",
                "roles": ["engineering leader", "AI/ML practitioner"],
                "note": "Populate content/about.json for richer details.",
            }
        )

    def _list_projects(self) -> str:
        data = self._read_json_file(self.projects_file) or {"projects": []}
        return json.dumps(data)

    def _get_project_details(self, arguments: Dict[str, Any]) -> str:
        name = (arguments.get("name") or "").strip().lower()
        data = self._read_json_file(self.projects_file) or {"projects": []}
        for project in data.get("projects", []):
            if isinstance(project, dict) and project.get("name", "").lower() == name:
                return json.dumps(project)
        return json.dumps({"error": f"Project not found: {name or 'unspecified'}"})

    def _list_github_repos(self) -> str:
        repos_path = self.github_dir / "repos.json"
        data = self._read_json_file(repos_path) or {"repos": []}
        return json.dumps(data)

    def _get_github_repo(self, arguments: Dict[str, Any]) -> str:
        name = (arguments.get("name") or "").strip().lower()
        file_arg = (arguments.get("file") or "").strip()
        if not name:
            return json.dumps({"error": "name is required"})

        repo_root = self.github_dir / self.github_owner / name
        if not repo_root.exists():
            return json.dumps({"error": f"Repo not cached: {name}"})

        target_file = file_arg or "README.md"
        # Prevent path traversal by resolving within repo_root.
        resolved = (repo_root / target_file).resolve()
        if repo_root not in resolved.parents and repo_root != resolved:
            return json.dumps({"error": "Invalid file path"})
        if not resolved.exists():
            return json.dumps({"error": f"File not cached: {target_file}"})

        try:
            content = resolved.read_text(encoding="utf-8")
        except Exception as exc:  # pragma: no cover - defensive
            return json.dumps({"error": f"Unable to read file: {exc}"})

        return json.dumps({"repo": name, "file": target_file, "content": content[:100_000]})

    async def _fetch_live_page(self, arguments: Dict[str, Any]) -> str:
        slug = (arguments.get("slug_or_url") or "").strip()
        if not slug:
            return json.dumps({"error": "slug_or_url is required"})

        url = slug
        if not slug.startswith("http://") and not slug.startswith("https://"):
            url = urljoin(self.live_site_base_url.rstrip("/") + "/", slug)

        parsed = urlparse(url)
        host = parsed.hostname or ""
        if host.lower() not in {h.lower() for h in self.live_allowed_hosts}:
            return json.dumps({"error": "Host not allowed for live fetch", "allowed_hosts": self.live_allowed_hosts})

        try:
            async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
                response = await client.get(url)
                response.raise_for_status()
                raw = response.content[:200_000]
        except Exception as exc:  # noqa: BLE001
            fallback = json.loads(self._fetch_site_page({"slug_or_url": slug}))
            return json.dumps({"error": f"Live fetch failed: {exc}", "cached": fallback})

        text = _html_to_text(raw.decode("utf-8", errors="ignore"))
        return json.dumps({"url": url, "content": text[:100_000]})

    async def _search_web(self, arguments: Dict[str, Any]) -> str:
        if not self.search_api_url:
            return json.dumps({"error": "SEARCH_API_URL is not configured"})

        query = (arguments.get("query") or "").strip()
        if not query:
            return json.dumps({"error": "query is required"})
        max_results = int(arguments.get("max_results") or 5)

        params = {"q": query, "format": "json", "language": "en", "safesearch": 1}
        # Common SearxNG parameter name is "format"; some proxies might prefer max_results or num_results
        params["max_results"] = max_results

        headers: Dict[str, str] = {}
        if self.search_api_key:
            headers["Authorization"] = f"Bearer {self.search_api_key}"

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(self.search_api_url, params=params, headers=headers)
                response.raise_for_status()
                data = response.json()
        except Exception as exc:  # noqa: BLE001
            return json.dumps({"error": f"Web search failed: {exc}"})

        raw_results = data.get("results") or data.get("items") or []
        results: List[Dict[str, str]] = []
        for item in raw_results[:max_results]:
            if not isinstance(item, dict):
                continue
            title = item.get("title") or item.get("name") or ""
            url = item.get("url") or item.get("link") or ""
            snippet = item.get("content") or item.get("snippet") or item.get("summary") or ""
            if not url:
                continue
            results.append({"title": title, "url": url, "snippet": snippet})

        return json.dumps({"query": query, "results": results, "source": self.search_api_url})
