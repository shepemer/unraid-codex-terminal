#!/usr/bin/env python3

from pathlib import Path
import sys
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "templates"
errors: list[str] = []


for template in sorted(TEMPLATES.glob("*.xml")):
    try:
        ET.parse(template)
    except ET.ParseError as exc:
        errors.append(f"{template.relative_to(ROOT)} is invalid XML: {exc}")

def require_empty_defaults(template_name: str, config_names: tuple[str, ...]) -> None:
    template_path = TEMPLATES / template_name
    template = ET.parse(template_path).getroot()
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
