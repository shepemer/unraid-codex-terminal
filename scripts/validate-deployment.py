#!/usr/bin/env python3

import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "templates"
errors: list[str] = []
REPOSITORY_URL = "https://github.com/shepemer/unraid-addons"
RAW_URL = "https://raw.githubusercontent.com/shepemer/unraid-addons/main"
RETIRED_SLUG = "unraid-codex-" + "terminal"
RETIRED_BRAND = "Unraid Codex " + "Terminal"

EXPECTED_TEMPLATES = {
    "codex-terminal.xml": (
        "codex-terminal",
        "unraid-addons-codex-terminal",
        "codex-terminal.png",
    ),
    "unraid-mcp.xml": ("unraid-mcp", "unraid-addons-unraid-mcp", "unraid-mcp.png"),
    "media-mcp.xml": ("media-mcp", "unraid-addons-media-mcp", "unraid-mcp.png"),
    "media-issue-agent.xml": (
        "media-issue-agent",
        "unraid-addons-media-issue-agent",
        "unraid-mcp.png",
    ),
    "utilities-mcp.xml": (
        "utilities-mcp",
        "unraid-addons-utilities-mcp",
        "unraid-mcp.png",
    ),
}

EXPECTED_STABLE_CONFIGS = {
    "codex-terminal.xml": {
        "SSH Port": ("2222", "2222", "2222"),
        "WebUI Port": ("7681", "7681", "7681"),
        "Appdata": (
            "/config",
            "/mnt/user/appdata/codex-terminal",
            "/mnt/user/appdata/codex-terminal",
        ),
        "Unraid MCP Bearer Token": ("UNRAID_MCP_BEARER_TOKEN", "", ""),
        "Media MCP URL": (
            "MEDIA_MCP_URL",
            "http://media-mcp:6971/mcp",
            "http://media-mcp:6971/mcp",
        ),
        "Media MCP Bearer Token": ("MEDIA_MCP_BEARER_TOKEN", "", ""),
        "Utilities MCP URL": (
            "UTILITIES_MCP_URL",
            "http://utilities-mcp:6972/mcp",
            "http://utilities-mcp:6972/mcp",
        ),
        "Utilities MCP Bearer Token": ("UTILITIES_MCP_BEARER_TOKEN", "", ""),
    },
    "unraid-mcp.xml": {
        "State": (
            "/home/mcp/.unraid-mcp",
            "/mnt/user/appdata/unraid-mcp/state",
            "/mnt/user/appdata/unraid-mcp/state",
        ),
        "Logs": (
            "/app/logs",
            "/mnt/user/appdata/unraid-mcp/logs",
            "/mnt/user/appdata/unraid-mcp/logs",
        ),
        "Backups": (
            "/app/backups",
            "/mnt/user/appdata/unraid-mcp/backups",
            "/mnt/user/appdata/unraid-mcp/backups",
        ),
        "Unraid API URL": (
            "UNRAID_API_URL",
            "http://tower.local/graphql",
            "http://tower.local/graphql",
        ),
        "Unraid API Key": ("UNRAID_API_KEY", "", ""),
        "Unraid MCP Bearer Token": ("UNRAID_MCP_BEARER_TOKEN", "", ""),
        "MCP Port": ("UNRAID_MCP_PORT", "6970", "6970"),
    },
    "media-mcp.xml": {
        "Media MCP Bearer Token": ("MEDIA_MCP_BEARER_TOKEN", "", ""),
        "MCP Host": ("MEDIA_MCP_HOST", "0.0.0.0", "0.0.0.0"),
        "MCP Port": ("MEDIA_MCP_PORT", "6971", "6971"),
        "Downloads Automation Mount": ("/mnt/unraid/downloads", "", ""),
        "Media Automation Mount": ("/mnt/unraid/media", "", ""),
        "Allowed Media Delete Roots": ("MEDIA_MCP_MEDIA_ROOTS", "", ""),
        "Media MCP Path Maps": ("MEDIA_MCP_PATH_MAPS", "", ""),
    },
    "media-issue-agent.xml": {
        "State Directory": (
            "/state",
            "/mnt/user/appdata/media-issue-agent/state",
            "/mnt/user/appdata/media-issue-agent/state",
        ),
        "Codex Home": (
            "/codex-home",
            "/mnt/user/appdata/media-issue-agent/codex",
            "/mnt/user/appdata/media-issue-agent/codex",
        ),
        "WebUI Port": ("6983", "6983", "6983"),
        "Media MCP URL": (
            "ISSUE_AGENT_MEDIA_MCP_URL",
            "http://media-mcp:6971/mcp",
            "http://media-mcp:6971/mcp",
        ),
        "Media MCP Bearer Token": (
            "ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN",
            "",
            "",
        ),
        "Codex Home Env": ("CODEX_HOME", "/codex-home", "/codex-home"),
        "DB Path": (
            "ISSUE_AGENT_DB_PATH",
            "/state/media-issue-agent.sqlite",
            "/state/media-issue-agent.sqlite",
        ),
        "Repair Workspace Root": (
            "ISSUE_AGENT_REPAIR_WORKSPACE_ROOT",
            "/state/repair-workspaces",
            "/state/repair-workspaces",
        ),
    },
    "utilities-mcp.xml": {
        "Utilities MCP Bearer Token": ("UTILITIES_MCP_BEARER_TOKEN", "", ""),
        "MCP Host": ("UTILITIES_MCP_HOST", "0.0.0.0", "0.0.0.0"),
        "MCP Port": ("UTILITIES_MCP_PORT", "6972", "6972"),
        "Scrutiny URL": ("SCRUTINY_URL", "", ""),
        "Scrutiny Base Path": ("SCRUTINY_BASE_PATH", "", ""),
    },
}

EXPECTED_TEMPLATE_TARGETS = {
    "codex-terminal.xml": (
        "2222",
        "7681",
        "/config",
        "/mnt/unraid/media",
        "/mnt/unraid/downloads",
        "SSH_AUTHORIZED_KEYS",
        "SSH_PASSWORD_LOGIN",
        "SSH_PASSWORD",
        "SSH_PASSWORD_HASH",
        "WEBUI_ENABLED",
        "WEBUI_AUTH",
        "WEBUI_USERNAME",
        "WEBUI_PASSWORD",
        "WEBUI_MAX_CLIENTS",
        "WEBUI_TMUX_SESSION",
        "WEBUI_LOG_LEVEL",
        "AUTO_LAUNCH_CODEX",
        "CODEX_WEBUI_BYPASS_APPROVALS",
        "CODEX_UPDATE_ON_START",
        "CODEX_NPM_VERSION",
        "CODEX_UPDATE_ON_START_TIMEOUT",
        "CODEX_MEDIA_PATH_MAPS",
        "UNRAID_MCP_BEARER_TOKEN",
        "MEDIA_MCP_URL",
        "MEDIA_MCP_BEARER_TOKEN",
        "UTILITIES_MCP_URL",
        "UTILITIES_MCP_BEARER_TOKEN",
    ),
    "unraid-mcp.xml": (
        "/home/mcp/.unraid-mcp",
        "/app/logs",
        "/app/backups",
        "UNRAID_API_URL",
        "UNRAID_API_KEY",
        "UNRAID_MCP_BEARER_TOKEN",
        "UNRAID_MCP_TRANSPORT",
        "UNRAID_MCP_HOST",
        "UNRAID_MCP_PORT",
    ),
    "media-mcp.xml": (
        "MEDIA_MCP_BEARER_TOKEN",
        "MEDIA_MCP_HOST",
        "MEDIA_MCP_PORT",
        "MEDIA_MCP_REQUEST_TIMEOUT_MS",
        "/mnt/unraid/downloads",
        "/mnt/unraid/media",
        "MEDIA_MCP_MEDIA_ROOTS",
        "MEDIA_MCP_PATH_MAPS",
        "SONARR_URL",
        "SONARR_API_KEY",
        "RADARR_URL",
        "RADARR_API_KEY",
        "PLEX_URL",
        "PLEX_TOKEN",
        "TAUTULLI_URL",
        "TAUTULLI_API_KEY",
        "TRACEARR_URL",
        "TRACEARR_API_KEY",
        "THREADFIN_URL",
        "THREADFIN_USERNAME",
        "THREADFIN_PASSWORD",
        "THREADFIN_TOKEN",
        "BAZARR_URL",
        "BAZARR_API_KEY",
        "PROWLARR_URL",
        "PROWLARR_API_KEY",
        "QBITTORRENT_URL",
        "QBITTORRENT_USERNAME",
        "QBITTORRENT_PASSWORD",
        "NZBGET_URL",
        "NZBGET_USERNAME",
        "NZBGET_PASSWORD",
        "SEERR_URL",
        "SEERR_API_KEY",
    ),
    "media-issue-agent.xml": (
        "/state",
        "/codex-home",
        "6983",
        "ISSUE_AGENT_MEDIA_MCP_URL",
        "ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN",
        "ISSUE_AGENT_WEB_USERNAME",
        "ISSUE_AGENT_WEB_PASSWORD",
        "CODEX_HOME",
        "ISSUE_AGENT_DB_PATH",
        "ISSUE_AGENT_REPAIR_WORKSPACE_ROOT",
        "ISSUE_AGENT_REPAIR_CONTEXT",
        "ISSUE_AGENT_SERVER_OWNER_REPORTER_USERNAME",
        "ISSUE_AGENT_POLL_INTERVAL_SECONDS",
        "ISSUE_AGENT_SNAPSHOT_RETENTION",
        "ISSUE_AGENT_CODEX_MODEL",
        "ISSUE_AGENT_CODEX_REASONING_EFFORT",
        "ISSUE_AGENT_CODEX_FAST_MODE",
        "ISSUE_AGENT_CODEX_SERVICE_TIER",
        "ISSUE_AGENT_CODEX_ENV_ALLOWLIST",
        "ISSUE_AGENT_WEB_ENABLED",
        "ISSUE_AGENT_WEB_HOST",
        "ISSUE_AGENT_WEB_PORT",
        "ISSUE_AGENT_PUSHOVER_APP_TOKEN",
        "ISSUE_AGENT_PUSHOVER_USER_KEY",
        "ISSUE_AGENT_SLACK_ENABLED",
        "ISSUE_AGENT_SLACK_APP_TOKEN",
        "ISSUE_AGENT_SLACK_BOT_TOKEN",
        "ISSUE_AGENT_SLACK_CHANNEL_ID",
        "ISSUE_AGENT_OPENAI_MODERATION_API_KEY",
    ),
    "utilities-mcp.xml": (
        "UTILITIES_MCP_BEARER_TOKEN",
        "UTILITIES_MCP_HOST",
        "UTILITIES_MCP_PORT",
        "UTILITIES_MCP_REQUEST_TIMEOUT_MS",
        "SCRUTINY_URL",
        "SCRUTINY_BASE_PATH",
    ),
}

EXPECTED_COMPOSE_ENVIRONMENT_KEYS = {
    "codex-terminal": (
        "SSH_AUTHORIZED_KEYS",
        "SSH_PASSWORD_LOGIN",
        "SSH_PASSWORD",
        "SSH_PASSWORD_HASH",
        "UNRAID_MCP_BEARER_TOKEN",
        "MEDIA_MCP_URL",
        "MEDIA_MCP_BEARER_TOKEN",
        "UTILITIES_MCP_URL",
        "UTILITIES_MCP_BEARER_TOKEN",
        "WEBUI_ENABLED",
        "WEBUI_AUTH",
        "WEBUI_USERNAME",
        "WEBUI_PASSWORD",
        "WEBUI_PORT",
        "WEBUI_MAX_CLIENTS",
        "WEBUI_TMUX_SESSION",
        "WEBUI_LOG_LEVEL",
        "AUTO_LAUNCH_CODEX",
        "CODEX_WEBUI_BYPASS_APPROVALS",
        "CODEX_UPDATE_ON_START",
        "CODEX_NPM_VERSION",
        "CODEX_UPDATE_ON_START_TIMEOUT",
        "CODEX_MEDIA_PATH_MAPS",
    ),
    "unraid-mcp": (
        "UNRAID_API_URL",
        "UNRAID_API_KEY",
        "UNRAID_MCP_BEARER_TOKEN",
        "UNRAID_MCP_TRANSPORT",
        "UNRAID_MCP_HOST",
        "UNRAID_MCP_PORT",
    ),
    "media-mcp": (
        "MEDIA_MCP_BEARER_TOKEN",
        "MEDIA_MCP_HOST",
        "MEDIA_MCP_PORT",
        "MEDIA_MCP_REQUEST_TIMEOUT_MS",
        "SONARR_URL",
        "SONARR_API_KEY",
        "RADARR_URL",
        "RADARR_API_KEY",
        "PROWLARR_URL",
        "PROWLARR_API_KEY",
        "QBITTORRENT_URL",
        "QBITTORRENT_USERNAME",
        "QBITTORRENT_PASSWORD",
        "NZBGET_URL",
        "NZBGET_USERNAME",
        "NZBGET_PASSWORD",
        "SEERR_URL",
        "SEERR_API_KEY",
        "PLEX_URL",
        "PLEX_TOKEN",
        "TAUTULLI_URL",
        "TAUTULLI_API_KEY",
        "TRACEARR_URL",
        "TRACEARR_API_KEY",
        "BAZARR_URL",
        "BAZARR_API_KEY",
        "THREADFIN_URL",
        "THREADFIN_USERNAME",
        "THREADFIN_PASSWORD",
        "THREADFIN_TOKEN",
        "MEDIA_MCP_PATH_MAPS",
        "MEDIA_MCP_MEDIA_ROOTS",
    ),
    "media-issue-agent": (
        "CODEX_HOME",
        "ISSUE_AGENT_MEDIA_MCP_URL",
        "ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN",
        "ISSUE_AGENT_DB_PATH",
        "ISSUE_AGENT_LOG_PATH",
        "ISSUE_AGENT_REPAIR_WORKSPACE_ROOT",
        "ISSUE_AGENT_REPAIR_CONTEXT",
        "ISSUE_AGENT_SERVER_OWNER_REPORTER_USERNAME",
        "ISSUE_AGENT_POLL_INTERVAL_SECONDS",
        "ISSUE_AGENT_SNAPSHOT_RETENTION",
        "ISSUE_AGENT_CODEX_MODEL",
        "ISSUE_AGENT_CODEX_REASONING_EFFORT",
        "ISSUE_AGENT_CODEX_FAST_MODE",
        "ISSUE_AGENT_CODEX_SERVICE_TIER",
        "ISSUE_AGENT_CODEX_REPAIR_TIMEOUT_MS",
        "ISSUE_AGENT_MCP_REQUEST_TIMEOUT_MS",
        "ISSUE_AGENT_RECOVER_STALE_RUN_SECONDS",
        "ISSUE_AGENT_CODEX_ENV_ALLOWLIST",
        "ISSUE_AGENT_WEB_ENABLED",
        "ISSUE_AGENT_WEB_HOST",
        "ISSUE_AGENT_WEB_PORT",
        "ISSUE_AGENT_WEB_USERNAME",
        "ISSUE_AGENT_WEB_PASSWORD",
        "ISSUE_AGENT_PUSHOVER_APP_TOKEN",
        "ISSUE_AGENT_PUSHOVER_USER_KEY",
        "ISSUE_AGENT_SLACK_ENABLED",
        "ISSUE_AGENT_SLACK_APP_TOKEN",
        "ISSUE_AGENT_SLACK_BOT_TOKEN",
        "ISSUE_AGENT_SLACK_CHANNEL_ID",
        "ISSUE_AGENT_OPENAI_MODERATION_API_KEY",
    ),
    "utilities-mcp": (
        "UTILITIES_MCP_BEARER_TOKEN",
        "UTILITIES_MCP_HOST",
        "UTILITIES_MCP_PORT",
        "UTILITIES_MCP_REQUEST_TIMEOUT_MS",
        "SCRUTINY_URL",
        "SCRUTINY_BASE_PATH",
    ),
}


def require_equal(location: str, actual: str | None, expected: str) -> None:
    if actual != expected:
        errors.append(f"{location} must be {expected!r}, got {actual!r}")


def require_count(location: str, text: str, value: str, expected: int) -> None:
    actual = text.count(value)
    if actual != expected:
        errors.append(
            f"{location} must contain {value!r} {expected} time(s), got {actual}"
        )


def require_sequence(
    location: str, actual: list[str | None], expected: tuple[str, ...]
) -> None:
    if actual != list(expected):
        errors.append(f"{location} changed: expected {list(expected)!r}, got {actual!r}")


parsed_templates: dict[str, ET.Element] = {}
for template in sorted(TEMPLATES.glob("*.xml")):
    try:
        parsed_templates[template.name] = ET.parse(template).getroot()
    except ET.ParseError as exc:
        errors.append(f"{template.relative_to(ROOT)} is invalid XML: {exc}")

for template_name, (
    container_name,
    package_name,
    icon_name,
) in EXPECTED_TEMPLATES.items():
    template = parsed_templates.get(template_name)
    if template is None:
        errors.append(f"templates/{template_name} is missing or invalid")
        continue
    prefix = f"templates/{template_name}"
    require_equal(f"{prefix} Name", template.findtext("Name"), container_name)
    require_equal(
        f"{prefix} Repository",
        template.findtext("Repository"),
        f"ghcr.io/shepemer/{package_name}:latest",
    )
    require_equal(
        f"{prefix} Registry",
        template.findtext("Registry"),
        f"{REPOSITORY_URL}/pkgs/container/{package_name}",
    )
    require_equal(f"{prefix} Network", template.findtext("Network"), "codex-mgmt")
    require_equal(
        f"{prefix} Support", template.findtext("Support"), f"{REPOSITORY_URL}/issues"
    )
    require_equal(f"{prefix} Project", template.findtext("Project"), REPOSITORY_URL)
    require_equal(
        f"{prefix} TemplateURL",
        template.findtext("TemplateURL"),
        f"{RAW_URL}/templates/{template_name}",
    )
    require_equal(
        f"{prefix} Icon",
        template.findtext("Icon"),
        f"{RAW_URL}/assets/icons/{icon_name}",
    )

for template_name, expected_configs in EXPECTED_STABLE_CONFIGS.items():
    template = parsed_templates.get(template_name)
    if template is None:
        continue
    for config_name, (target, default, value) in expected_configs.items():
        config = template.find(f"./Config[@Name='{config_name}']")
        location = f"templates/{template_name} Config {config_name!r}"
        if config is None:
            errors.append(f"{location} is missing")
            continue
        require_equal(f"{location} Target", config.get("Target"), target)
        require_equal(f"{location} Default", config.get("Default"), default)
        require_equal(f"{location} value", config.text or "", value)

for template_name, expected_targets in EXPECTED_TEMPLATE_TARGETS.items():
    template = parsed_templates.get(template_name)
    if template is None:
        continue
    require_sequence(
        f"templates/{template_name} Config targets",
        [config.get("Target") for config in template.findall("Config")],
        expected_targets,
    )


def require_empty_defaults(template_name: str, config_names: tuple[str, ...]) -> None:
    template = parsed_templates.get(template_name)
    if template is None:
        return
    for name in config_names:
        config = template.find(f"./Config[@Name='{name}']")
        if config is None:
            errors.append(f"templates/{template_name} is missing {name!r}")
            continue
        if config.get("Default", "").strip() or (config.text or "").strip():
            errors.append(
                f"templates/{template_name} {name!r} must not default to a "
                "host path"
            )


require_empty_defaults(
    "media-mcp.xml",
    (
        "Downloads Automation Mount",
        "Media Automation Mount",
        "Allowed Media Delete Roots",
        "Media MCP Path Maps",
    ),
)
require_empty_defaults(
    "codex-terminal.xml",
    ("Downloads Diagnostics Mount", "Media Diagnostics Mount"),
)

compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
require_count(
    "docker-compose.yml",
    compose,
    "name: unraid-codex-terminal",
    1,
)
expected_compose_images = {
    "CODEX_TERMINAL_IMAGE": "ghcr.io/shepemer/unraid-addons-codex-terminal:dev",
    "UNRAID_MCP_IMAGE": "ghcr.io/shepemer/unraid-addons-unraid-mcp:1.2.4-dev",
    "MEDIA_MCP_IMAGE": "ghcr.io/shepemer/unraid-addons-media-mcp:dev",
    "ISSUE_AGENT_IMAGE": "ghcr.io/shepemer/unraid-addons-media-issue-agent:dev",
    "UTILITIES_MCP_IMAGE": "ghcr.io/shepemer/unraid-addons-utilities-mcp:dev",
}
for variable, image in expected_compose_images.items():
    require_count(
        "docker-compose.yml",
        compose,
        f"${{{variable}:-{image}}}",
        1,
    )

for service in (
    "codex-terminal",
    "unraid-mcp",
    "media-mcp",
    "media-issue-agent",
    "utilities-mcp",
):
    require_count("docker-compose.yml services", compose, f"\n  {service}:\n", 1)
    require_count(
        "docker-compose.yml container names",
        compose,
        f"container_name: {service}",
        1,
    )

for stable_compose_fragment in (
    "name: codex-mgmt",
    '"${CODEX_SSH_PORT:-2222}:2222/tcp"',
    '"${CODEX_WEBUI_PORT:-7681}:7681/tcp"',
    '"${ISSUE_AGENT_WEBUI_PORT:-6983}:6983/tcp"',
    "MEDIA_MCP_URL: ${MEDIA_MCP_URL:-http://media-mcp:6971/mcp}",
    "UTILITIES_MCP_URL: ${UTILITIES_MCP_URL:-http://utilities-mcp:6972/mcp}",
    "ISSUE_AGENT_MEDIA_MCP_URL: "
    "${ISSUE_AGENT_MEDIA_MCP_URL:-http://media-mcp:6971/mcp}",
    "${CODEX_CONFIG_DIR:-./data/codex-terminal}:/config:rw",
    "${UNRAID_MCP_STATE_DIR:-./data/unraid-mcp/state}:"
    "/home/mcp/.unraid-mcp:rw",
    "${UNRAID_MCP_LOG_DIR:-./data/unraid-mcp/logs}:/app/logs:rw",
    "${UNRAID_MCP_BACKUP_DIR:-./data/unraid-mcp/backups}:/app/backups:rw",
    "${ISSUE_AGENT_STATE_DIR:-./data/media-issue-agent/state}:/state:rw",
    "${ISSUE_AGENT_CODEX_HOME:-./data/media-issue-agent/codex}:"
    "/codex-home:rw",
):
    require_count(
        "docker-compose.yml stable runtime interfaces",
        compose,
        stable_compose_fragment,
        1,
    )

compose_environment_keys: dict[str, list[str | None]] = {}
current_service: str | None = None
in_environment = False
for line in compose.splitlines():
    if line.startswith("  ") and not line.startswith("    ") and line.endswith(":"):
        current_service = line.strip()[:-1]
        in_environment = False
    elif current_service is not None and line == "    environment:":
        compose_environment_keys[current_service] = []
        in_environment = True
    elif in_environment:
        if line.startswith("      ") and ":" in line:
            compose_environment_keys[current_service].append(
                line.strip().split(":", 1)[0]
            )
        elif line.strip() and not line.startswith("      "):
            in_environment = False

for service, expected_keys in EXPECTED_COMPOSE_ENVIRONMENT_KEYS.items():
    require_sequence(
        f"docker-compose.yml {service} environment keys",
        compose_environment_keys.get(service, []),
        expected_keys,
    )

environment = (ROOT / ".env.example").read_text(encoding="utf-8")
for variable, image in expected_compose_images.items():
    require_count(".env.example", environment, f"{variable}={image}", 1)

workflow = (ROOT / ".github/workflows/docker.yml").read_text(encoding="utf-8")
expected_workflow_images = {
    "TERMINAL_IMAGE": "unraid-addons-codex-terminal",
    "MCP_IMAGE": "unraid-addons-unraid-mcp",
    "MEDIA_MCP_IMAGE": "unraid-addons-media-mcp",
    "ISSUE_AGENT_IMAGE": "unraid-addons-media-issue-agent",
    "UTILITIES_MCP_IMAGE": "unraid-addons-utilities-mcp",
}
for variable, image in expected_workflow_images.items():
    require_count(".github/workflows/docker.yml", workflow, f"{variable}: {image}", 1)
for label in (
    "org.opencontainers.image.source",
    "org.opencontainers.image.revision",
    "org.opencontainers.image.title",
    "org.opencontainers.image.description",
):
    require_count(".github/workflows/docker.yml", workflow, f"{label}=", 1)

npm_packages = {
    "media-mcp": "unraid-addons-media-mcp",
    "media-issue-agent": "unraid-addons-media-issue-agent",
    "utilities-mcp": "unraid-addons-utilities-mcp",
}
for directory, expected_name in npm_packages.items():
    manifest = json.loads(
        (ROOT / directory / "package.json").read_text(encoding="utf-8")
    )
    lock = json.loads(
        (ROOT / directory / "package-lock.json").read_text(encoding="utf-8")
    )
    require_equal(f"{directory}/package.json name", manifest.get("name"), expected_name)
    require_equal(f"{directory}/package-lock.json name", lock.get("name"), expected_name)
    require_equal(
        f"{directory}/package-lock.json root name",
        lock.get("packages", {}).get("", {}).get("name"),
        expected_name,
    )
    if RETIRED_BRAND in manifest.get("description", ""):
        errors.append(f"{directory}/package.json contains the retired project brand")

media_server = (ROOT / "media-mcp/server.js").read_text(encoding="utf-8")
require_count(
    "media-mcp/server.js",
    media_server,
    'name: "unraid-codex-media-mcp"',
    1,
)
require_count(
    "media-mcp/server.js",
    media_server,
    '"X-Plex-Client-Identifier": "unraid-codex-media-mcp"',
    2,
)
require_count(
    "media-mcp/server.js",
    media_server,
    '"X-Plex-Product": "Unraid Addons Media MCP"',
    2,
)
require_count(
    "media-mcp/server.js", media_server, f"{RETIRED_BRAND} Media MCP", 0
)

utilities_server = (ROOT / "utilities-mcp/server.js").read_text(encoding="utf-8")
require_count(
    "utilities-mcp/server.js",
    utilities_server,
    'name: "unraid-codex-utilities-mcp"',
    1,
)

entrypoint = (ROOT / "entrypoint.sh").read_text(encoding="utf-8")
require_count("entrypoint.sh", entrypoint, "[mcp_servers.unraid]", 1)
for stable_mcp_url in (
    'MCP_URL="${UNRAID_MCP_URL:-http://unraid-mcp:6970/mcp}"',
    'MEDIA_MCP_URL="${MEDIA_MCP_URL:-http://media-mcp:6971/mcp}"',
    'UTILITIES_MCP_URL="${UTILITIES_MCP_URL:-http://utilities-mcp:6972/mcp}"',
):
    require_count("entrypoint.sh stable MCP URLs", entrypoint, stable_mcp_url, 1)
require_count("entrypoint.sh", entrypoint, 'sync_optional_mcp_server_block "media"', 1)
require_count(
    "entrypoint.sh", entrypoint, 'sync_optional_mcp_server_block "utilities"', 1
)

issue_agent_codex = (ROOT / "media-issue-agent/src/codex.js").read_text(
    encoding="utf-8"
)
for stable_override in (
    "mcp_servers.media.url=",
    "mcp_servers.media.bearer_token_env_var=",
    "mcp_servers.media.default_tools_approval_mode=",
    "mcp_servers.media.required=",
    "mcp_servers.media.tool_timeout_sec=",
):
    require_count(
        "media-issue-agent/src/codex.js", issue_agent_codex, stable_override, 1
    )

legacy_ghcr_prefix = f"ghcr.io/shepemer/{RETIRED_SLUG}"
retired_github_url = f"github.com/shepemer/{RETIRED_SLUG}"
retired_raw_url = f"raw.githubusercontent.com/shepemer/{RETIRED_SLUG}"
docs = (ROOT / "docs.md").read_text(encoding="utf-8")
require_count("docs.md migration table", docs, legacy_ghcr_prefix, 5)
require_count("docs.md SSH alias", docs, "Host unraid-codex", 1)
readme = (ROOT / "README.md").read_text(encoding="utf-8")
require_count("README.md SSH alias", readme, "Host unraid-codex", 1)

excluded_parts = {".git", "node_modules", "coverage"}
for path in ROOT.rglob("*"):
    if not path.is_file() or excluded_parts.intersection(path.relative_to(ROOT).parts):
        continue
    data = path.read_bytes()
    if b"\0" in data:
        continue
    text = data.decode("utf-8", errors="replace")
    relative = path.relative_to(ROOT).as_posix()
    if retired_github_url in text:
        errors.append(f"{relative} contains the retired GitHub repository URL")
    if retired_raw_url in text:
        errors.append(f"{relative} contains the retired raw-content repository URL")
    if RETIRED_BRAND in text:
        errors.append(f"{relative} contains the retired human-facing project brand")
    if legacy_ghcr_prefix in text and relative != "docs.md":
        errors.append(
            f"{relative} contains a legacy GHCR reference outside migration docs"
        )

for unsafe_default in (
    "${MEDIA_MCP_DOWNLOADS_DIR:-",
    "${MEDIA_MCP_MEDIA_DIR:-",
    "/mnt/user/downloads",
    "/mnt/user/media",
):
    if unsafe_default in compose:
        errors.append(
            f"docker-compose.yml contains unsafe media-mcp path default "
            f"{unsafe_default!r}"
        )

mount_override = (
    ROOT / "docker-compose.media-paths.yml.example"
).read_text(encoding="utf-8")
if mount_override.count("create_host_path: false") != 2:
    errors.append(
        "docker-compose.media-paths.yml.example must prevent Docker from "
        "creating both optional host paths"
    )
for required_variable in ("MEDIA_MCP_DOWNLOADS_DIR:?", "MEDIA_MCP_MEDIA_DIR:?"):
    if required_variable not in mount_override:
        errors.append(
            "docker-compose.media-paths.yml.example must require "
            f"{required_variable.removesuffix(':?')}"
        )

if errors:
    for error in errors:
        print(f"deployment validation failed: {error}", file=sys.stderr)
    raise SystemExit(1)

print("deployment validation passed")
