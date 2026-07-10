from __future__ import annotations

import json
from pathlib import Path

from roomtalk_code_agent_runner.codex_app_server import _turn_start_params
from roomtalk_code_agent_runner.codex_cli import (
    ROOM_CONTEXT_PERMISSION_PROFILE,
    CodexCliRunConfig,
    _build_codex_exec_args,
    _write_codex_config,
)
from roomtalk_code_agent_runner.runner import _read_only_shell_argv, parse_request


def plan_request(workspace: Path):
    return parse_request(json.dumps({
        "schemaVersion": 1,
        "type": "run",
        "roomId": "room-1",
        "turnId": "turn-1",
        "sessionId": None,
        "prompt": "inspect the project",
        "mode": "plan",
        "provider": "codex",
        "modelId": "gpt-5.5",
        "apiModel": "gpt-5.5",
        "codexPermissionMode": "plan",
        "workspace": str(workspace),
        "allowedPaths": ["."],
    }))


def test_plan_shell_policy_is_read_only_and_offline_without_room_context(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    request = plan_request(workspace)
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin"}

    coco_argv = _read_only_shell_argv("git status --short", workspace, env)
    assert "--ro-bind" in coco_argv
    assert "--share-net" not in coco_argv
    assert _turn_start_params(request, env, workspace, "thread-1")["sandboxPolicy"] == {
        "type": "readOnly",
        "networkAccess": False,
    }

    codex_home = tmp_path / "codex-home"
    _write_codex_config(codex_home, request, env, workspace)
    config = (codex_home / "config.toml").read_text(encoding="utf-8")
    args = _build_codex_exec_args(CodexCliRunConfig(), request, env, workspace, tmp_path / "last.txt")
    assert 'sandbox_mode = "read-only"' in config
    assert "default_permissions" not in config
    assert args[args.index("--sandbox") + 1] == "read-only"


def test_plan_shell_policy_allows_only_turn_scoped_roomtalk_broker(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    request = plan_request(workspace)
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "ROOMTALK_ROOM_CONTEXT_SOCKET": str(tmp_path / "room-context.sock"),
    }

    coco_argv = _read_only_shell_argv("roomtalk room history --json", workspace, env)
    assert "--ro-bind" in coco_argv
    assert "--share-net" not in coco_argv
    assert "ROOMTALK_ROOM_CONTEXT_SOCKET" in coco_argv
    app_params = _turn_start_params(request, env, workspace, "thread-1")
    assert app_params["permissions"] == ROOM_CONTEXT_PERMISSION_PROFILE
    assert "sandboxPolicy" not in app_params

    codex_home = tmp_path / "codex-home"
    _write_codex_config(codex_home, request, env, workspace)
    config = (codex_home / "config.toml").read_text(encoding="utf-8")
    args = _build_codex_exec_args(CodexCliRunConfig(), request, env, workspace, tmp_path / "last.txt")
    assert "sandbox_mode" not in config
    assert f'default_permissions = "{ROOM_CONTEXT_PERMISSION_PROFILE}"' in config
    assert f'[permissions.{ROOM_CONTEXT_PERMISSION_PROFILE}]' in config
    assert 'extends = ":read-only"' in config
    assert f'[permissions.{ROOM_CONTEXT_PERMISSION_PROFILE}.network.unix_sockets]' in config
    assert f'"{tmp_path / "room-context.sock"}" = "allow"' in config
    assert "--sandbox" not in args
    assert f'default_permissions="{ROOM_CONTEXT_PERMISSION_PROFILE}"' in args
