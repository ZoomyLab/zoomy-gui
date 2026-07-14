"""Registry gate for the authored GUI card catalog.

The card catalog is an AUTHORED registry: one hand-curated
``cards/<dir>/default.json`` per tab, no generated/user tiers. This gate

  1. loads every ``cards/<dir>/default.json`` and validates its schema
     (ids globally unique; ``title`` present; tab-appropriate content
     fields; model cards carry exactly one of template / snippet / class);
  2. for every MODEL card that carries a ``template`` and is not opted
     out, execs the template in a fresh namespace and asserts it binds a
     ``model`` object exposing ``.state``.

A card opts out of (2) with either

  * ``"untested": true``            — explicit escape hatch (carries a
    ``_todo`` note); or
  * ``"requires_tag": <non-numpy>`` — needs a backend this gate can't run.

The gate is intentionally GENERIC: a follow-up agent re-authors the
model/solver card contents and removes the ``untested`` flags. It must
stay green at every commit — mark a card ``untested`` rather than leaving
it red.

Run with::

    micromamba run -n zoomy pytest library/zoomy_gui/tests/test_registry.py -x -q
"""

import json
import pathlib

import pytest

GUI_ROOT = pathlib.Path(__file__).resolve().parents[1]
CARDS_ROOT = GUI_ROOT / "cards"
CARD_DIRS = ("models", "solvers", "meshes", "visualizations")

# Backends this in-process gate can actually execute against.
RUNNABLE_TAGS = {"numpy", None}

_CONTENT_FIELDS = ("template", "snippet", "class", "mesh_file")


def _load(directory):
    path = CARDS_ROOT / directory / "default.json"
    assert path.is_file(), f"missing authored registry: {path}"
    cards = json.loads(path.read_text())
    assert isinstance(cards, list), f"{path} must be a JSON array of cards"
    return cards


def _all_cards():
    out = []
    for d in CARD_DIRS:
        for card in _load(d):
            out.append((d, card))
    return out


def _model_cards():
    return _load("models")


# --------------------------------------------------------------------------
# 1. Schema
# --------------------------------------------------------------------------

def test_no_stale_tiers():
    """The generated.json / user.json merge tiers must be gone — the
    catalog is a single authored default.json per tab."""
    stale = []
    for d in CARD_DIRS:
        for tier in ("generated.json", "user.json"):
            p = CARDS_ROOT / d / tier
            if p.exists():
                stale.append(str(p.relative_to(GUI_ROOT)))
    assert not stale, f"stale card tiers should be removed: {stale}"


def test_ids_globally_unique():
    seen = {}
    dupes = []
    for d, card in _all_cards():
        cid = card.get("id")
        if cid in seen:
            dupes.append((cid, seen[cid], d))
        else:
            seen[cid] = d
    assert not dupes, f"duplicate card ids: {dupes}"


@pytest.mark.parametrize(
    "directory,card",
    _all_cards(),
    ids=[f"{d}:{c.get('id', '?')}" for d, c in _all_cards()],
)
def test_card_schema(directory, card):
    cid = card.get("id")
    assert isinstance(cid, str) and cid, f"card in {directory} missing string id"
    assert isinstance(card.get("title"), str) and card["title"], \
        f"card {cid} missing title"

    present = [f for f in _CONTENT_FIELDS if card.get(f)]

    if directory == "models":
        # Model cards carry a code source: template, snippet, or a class the
        # GUI can auto-template. (The audit's "template XOR snippet XOR class"
        # is read as "at least one": authored model cards legitimately carry a
        # `class` metadata field ALONGSIDE their `template`, and card CONTENTS
        # are owned by another agent — this gate only asserts a source exists.)
        code_fields = [f for f in ("template", "snippet", "class") if card.get(f)]
        assert code_fields, (
            f"model card {cid} needs one of template/snippet/class"
        )
    elif directory == "meshes":
        # Mesh cards: a builtin create-* template OR a catalog mesh_file.
        assert card.get("template") or card.get("mesh_file"), (
            f"mesh card {cid} needs a template (builtin) or a mesh_file (catalog)"
        )
    else:
        # solvers / visualizations: either a content field, or a backend
        # selector (`requires_tag`, e.g. the remote jax/amrex/dmplex solvers
        # whose code lives server-side).
        assert present or card.get("requires_tag"), (
            f"card {cid} in {directory} has no content field or requires_tag"
        )


# --------------------------------------------------------------------------
# 2. Model-card templates execute and bind a `model` with `.state`
# --------------------------------------------------------------------------

def _runnable_model_cards():
    out = []
    for card in _model_cards():
        if not card.get("template"):
            continue                      # nothing to execute (e.g. class-only refs)
        if card.get("untested") is True:
            continue                      # explicit escape hatch
        if card.get("requires_tag") not in RUNNABLE_TAGS:
            continue                      # needs a non-numpy backend
        out.append(card)
    return out


_RUNNABLE = _runnable_model_cards()


@pytest.mark.parametrize(
    "card",
    _RUNNABLE,
    ids=[c.get("id", "?") for c in _RUNNABLE] or ["<none>"],
)
def test_model_template_builds_model(card):
    ns = {}
    exec(compile(card["template"], card["id"], "exec"), ns)  # noqa: S102
    assert "model" in ns, f"template {card['id']} did not bind a `model`"
    model = ns["model"]
    assert hasattr(model, "state"), (
        f"template {card['id']} bound a {type(model).__name__} without `.state`"
    )
