"""Comment- and docstring-free card code for the packed GUI sessions.

The thesis QR codes open these sessions as notebooks, and a notebook cell is
read, not maintained: the explanations belong in the thesis text, the cell
shows the code. The case files under thesis/cases stay as they are; every
packer runs its finished card code through strip() before writing the zip.

Token-based, so nothing but COMMENT tokens and docstring statements is
touched; the result must parse to the same AST as the source with its
docstrings removed, and strip() asserts exactly that.
"""
import ast
import io
import re
import tokenize


def _docstring_spans(tree):
    """(first_line, last_line, indent, alone) of every docstring statement."""
    spans = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.FunctionDef,
                                 ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        body = getattr(node, "body", None)
        if not body:
            continue
        first = body[0]
        if (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)):
            spans.append((first.lineno, first.end_lineno, first.col_offset,
                          len(body) == 1))
    return spans


def _without_docstrings(tree):
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if not body or not isinstance(node, (ast.Module, ast.FunctionDef,
                                             ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        first = body[0]
        if (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)):
            body[0] = ast.Pass() if len(body) == 1 else None
            node.body = [b for b in body if b is not None]
    return tree


def strip(src: str) -> str:
    """Return `src` without comments and docstrings; semantics unchanged."""
    lines = src.splitlines(keepends=True)
    # 1. comments: cut each COMMENT token out of its line
    cuts = {}
    for tok in tokenize.generate_tokens(io.StringIO(src).readline):
        if tok.type == tokenize.COMMENT:
            row, col = tok.start
            cuts.setdefault(row, []).append(col)
    for row, cols in cuts.items():
        line = lines[row - 1]
        nl = "\n" if line.endswith("\n") else ""
        lines[row - 1] = line[:min(cols)].rstrip() + nl
    # 2. docstrings: drop the statement, or leave `pass` behind for a body
    #    that consisted of nothing else
    for first, last, indent, alone in sorted(_docstring_spans(ast.parse(src)),
                                             reverse=True):
        repl = [" " * indent + "pass\n"] if alone else []
        lines[first - 1:last] = repl
    out = "".join(lines)
    # 3. tidy: no trailing spaces, at most two blank lines in a row, none at
    #    the top, one newline at the end
    out = "\n".join(l.rstrip() for l in out.splitlines())
    out = re.sub(r"\n{4,}", "\n\n\n", out).strip("\n") + "\n"
    # 4. the code is the same code
    want = ast.dump(_without_docstrings(ast.parse(src)))
    got = ast.dump(ast.parse(out))
    assert want == got, "strip() changed the code"
    return out


if __name__ == "__main__":
    import sys
    for path in sys.argv[1:]:
        with open(path) as f:
            sys.stdout.write(strip(f.read()))
