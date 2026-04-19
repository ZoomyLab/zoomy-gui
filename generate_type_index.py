#!/usr/bin/env python3
"""Walk an installed Python package and emit a flat JSON type index for
autocomplete / hover tooltips in the GUI editor.

Usage:
    python generate_type_index.py zoomy_core [zoomy_plotting ...] > types.json

Output shape:
    {
      "version": 1,
      "generated_at": "2026-04-19T...",
      "packages": ["zoomy_core", "zoomy_plotting"],
      "imports": {
         # short class name -> fully qualified dotted path
         "SMEInviscid": "zoomy_core.model.models.sme_model.SMEInviscid",
         ...
      },
      "symbols": {
         "zoomy_core.model.basemodel.Model": {
           "kind": "class",
           "bases": ["param.Parameterized"],
           "doc": "Base class for Zoomy models.",
           "members": {
              "describe": {
                "kind": "method",
                "signature": "describe(self, verbose=False, fmt='markdown')",
                "params": [
                  {"name": "verbose", "default": "False", "annotation": "bool"}
                ],
                "return": "str",
                "doc": "..."
              }
           }
         }
      }
    }

No runtime deps — uses stdlib `inspect`, `pkgutil`, `importlib`, `ast`
only. Skips private symbols (name starts with `_` except `__init__`),
C-extension methods that `inspect.signature` can't introspect, and
anything that raises during import (emits a warning to stderr).
"""
from __future__ import annotations

import argparse
import ast
import datetime as _dt
import importlib
import inspect
import json
import pkgutil
import sys
import types
from typing import Any


def _safe_signature(obj: Any):
    try:
        return inspect.signature(obj)
    except (TypeError, ValueError):
        return None


def _fmt_default(value: Any) -> str:
    if value is inspect.Parameter.empty:
        return ""
    try:
        return repr(value)
    except Exception:
        return f"<{type(value).__name__}>"


def _fmt_annotation(ann: Any) -> str:
    if ann is inspect.Parameter.empty:
        return ""
    # prefer the stringified annotation (handles PEP 563 forward refs)
    return getattr(ann, "__name__", None) or repr(ann)


def describe_callable(obj: Any) -> dict | None:
    sig = _safe_signature(obj)
    if sig is None:
        return None
    params = []
    for name, param in sig.parameters.items():
        if name == "self":
            continue
        params.append({
            "name": name,
            "kind": str(param.kind).split(".")[-1],
            "default": _fmt_default(param.default),
            "annotation": _fmt_annotation(param.annotation),
        })
    return {
        "signature": f"{getattr(obj, '__name__', 'fn')}{sig}",
        "params": params,
        "return": _fmt_annotation(sig.return_annotation),
        "doc": (inspect.getdoc(obj) or "").strip(),
    }


def describe_class(cls: type) -> dict:
    members = {}
    for name, member in inspect.getmembers(cls):
        if name.startswith("_") and name not in ("__init__",):
            continue
        if inspect.isfunction(member) or inspect.ismethod(member):
            desc = describe_callable(member)
            if desc is not None:
                desc["kind"] = "method"
                members[name] = desc
        elif isinstance(member, property):
            members[name] = {
                "kind": "property",
                "doc": (inspect.getdoc(member.fget) if member.fget else "") or "",
            }
        elif isinstance(member, (int, float, str, bool)) or member is None:
            members[name] = {
                "kind": "constant",
                "repr": repr(member),
            }
    bases = []
    for base in cls.__bases__:
        if base is object:
            continue
        bases.append(f"{base.__module__}.{base.__name__}")
    return {
        "kind": "class",
        "module": cls.__module__,
        "qualname": cls.__qualname__,
        "bases": bases,
        "doc": (inspect.getdoc(cls) or "").strip(),
        "members": members,
    }


def describe_function(fn) -> dict | None:
    desc = describe_callable(fn)
    if desc is None:
        return None
    desc["kind"] = "function"
    desc["module"] = getattr(fn, "__module__", "")
    return desc


def walk_package(pkg_name: str, symbols: dict, imports: dict, seen_modules: set) -> None:
    try:
        pkg = importlib.import_module(pkg_name)
    except Exception as e:  # noqa: BLE001
        print(f"[warn] cannot import {pkg_name}: {e}", file=sys.stderr)
        return

    _index_module(pkg, symbols, imports, seen_modules)
    if not hasattr(pkg, "__path__"):
        return
    for mod_info in pkgutil.walk_packages(pkg.__path__, prefix=pkg.__name__ + "."):
        try:
            mod = importlib.import_module(mod_info.name)
        except Exception as e:  # noqa: BLE001
            print(f"[warn] skipping {mod_info.name}: {e}", file=sys.stderr)
            continue
        _index_module(mod, symbols, imports, seen_modules)


def _index_module(mod, symbols: dict, imports: dict, seen_modules: set) -> None:
    if mod.__name__ in seen_modules:
        return
    seen_modules.add(mod.__name__)
    for name, member in vars(mod).items():
        if name.startswith("_"):
            continue
        # Only index symbols that are DEFINED in this package. Re-exports
        # get registered in `imports` so the completer can resolve short
        # names, but we don't re-describe them.
        if inspect.isclass(member):
            if not member.__module__.startswith(mod.__name__.split(".")[0]):
                imports.setdefault(name, f"{member.__module__}.{member.__name__}")
                continue
            dotted = f"{member.__module__}.{member.__name__}"
            if dotted not in symbols:
                symbols[dotted] = describe_class(member)
            imports.setdefault(name, dotted)
        elif inspect.isfunction(member):
            if not getattr(member, "__module__", "").startswith(mod.__name__.split(".")[0]):
                continue
            dotted = f"{member.__module__}.{member.__name__}"
            desc = describe_function(member)
            if desc is not None and dotted not in symbols:
                symbols[dotted] = desc
            imports.setdefault(name, dotted)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("packages", nargs="+", help="Package names to walk, e.g. zoomy_core zoomy_plotting")
    ap.add_argument("--output", "-o", default="-", help="Output path (default stdout)")
    args = ap.parse_args()

    symbols: dict = {}
    imports: dict = {}
    seen_modules: set = set()
    for pkg in args.packages:
        walk_package(pkg, symbols, imports, seen_modules)

    payload = {
        "version": 1,
        "generated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "packages": args.packages,
        "imports": dict(sorted(imports.items())),
        "symbols": dict(sorted(symbols.items())),
    }
    text = json.dumps(payload, indent=2, default=str)
    if args.output == "-":
        sys.stdout.write(text)
    else:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(text)
    print(
        f"[type-index] {len(symbols)} symbols from {len(args.packages)} package(s), "
        f"{len(imports)} short-name imports",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
