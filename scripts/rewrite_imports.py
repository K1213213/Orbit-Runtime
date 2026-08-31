#!/usr/bin/env python3
"""
Rewrite cross-package relative imports to `@orbit/<pkg>` barrel imports.

Strategy (resolution-based, not prefix-based):
  - For every .ts file under packages/*/src, src/, plus demo-*.ts and test/*.test.ts,
    scan each `from "..."` / `import "..."` / `import("...")` spec.
  - If the spec is relative:
      * Resolve it to a real target .ts file (handling extension / directory index).
        - If the target lives in the SAME package/scope as the source -> keep the
          relative import (intra-package, fine for composite projects).
        - If it lives in a DIFFERENT package -> rewrite to `@orbit/<targetPkg>`.
      * If the relative spec does NOT resolve to a real file (the target was moved
        during the monorepo split), derive its logical subpath and look it up in a
        global map of `subpath -> package`, then rewrite to `@orbit/<pkg>`.
  - Non-relative specs (@orbit/*, node builtins, bare modules) are left untouched.

Also emits detected dependency edges (sourcePkg -> set(targetPkg)) to
scripts/_detected_edges.json for wiring tsconfig project references.
"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(".").resolve()
PKG_DIR = ROOT / "packages"

# 1. Discover packages (name -> absolute src dir)
packages = {}
for d in sorted(PKG_DIR.iterdir()):
    if d.is_dir():
        src = d / "src"
        if src.is_dir():
            packages[d.name] = src.resolve()

# 2. Build subpath -> pkg map (package files only; used for dangling resolution)
subpath_to_pkg = {}
for name, src in packages.items():
    for f in src.rglob("*.ts"):
        rel = f.relative_to(src).with_suffix("").as_posix()
        subpath_to_pkg.setdefault(rel, name)

# 3. Determine which package (or "root") a file belongs to.
def pkg_of_file(path: Path):
    rp = path.resolve()
    for name, src in packages.items():
        try:
            rp.relative_to(src)
            return name
        except ValueError:
            continue
    rstr = str(rp).replace("\\", "/")
    rootstr = str(ROOT).replace("\\", "/")
    if rstr.startswith(rootstr + "/src/"):
        return "root"
    # demo-*.ts and test/*.test.ts are root-scope
    if rp.parent.name == "test" or rp.name.startswith("demo-"):
        return "root"
    return None

# Extra rootscope set for quick membership
rootscope_dirs = {ROOT / "src", ROOT / "test"}

def is_rootscope(path: Path):
    p = pkg_of_file(path)
    return p == "root"

# 4. Candidate files
targets = []
for name, src in packages.items():
    targets += sorted(src.rglob("*.ts"))
targets += sorted((ROOT / "src").rglob("*.ts"))
targets += sorted(ROOT.glob("demo-*.ts"))
targets += sorted((ROOT / "test").glob("*.test.ts"))

# 5. Regex for import/export specs
RE_FROM = re.compile(r'(\b(?:import|export)\b[^;\'"]*?\bfrom\s*)([\'"])([^\'"]+)\2')
RE_SIDE = re.compile(r'(\bimport\s*)([\'"])([^\'"]+)\2')
RE_DYN = re.compile(r'(\bimport\s*\(\s*)([\'"])([^\'"]+)\2(\s*\))')

def resolve_target(spec: str, source: Path):
    """Return (exists: bool, target_path_or_None)."""
    base = source.parent.resolve()
    joined = (base / spec).resolve()
    cands = []
    if joined.is_file():
        cands.append(joined)
    if joined.with_suffix(".ts").is_file():
        cands.append(joined.with_suffix(".ts"))
    if joined.is_dir() and (joined / "index.ts").is_file():
        cands.append(joined / "index.ts")
    if cands:
        return True, cands[0]
    return False, joined

def subpath_of_dangling(joined: Path, source: Path):
    """Derive the logical subpath for a dangling relative import."""
    spkg = pkg_of_file(source)
    if spkg in packages:
        base = packages[spkg]
        try:
            sub = joined.relative_to(base).with_suffix("").as_posix()
            return sub
        except ValueError:
            pass
    jstr = str(joined).replace("\\", "/")
    if "/src/" in jstr:
        sub = jstr.split("/src/", 1)[1]
        if sub.endswith(".ts"):
            sub = sub[:-3]
        return sub
    return joined.name

def rewrite_spec(spec: str, source: Path):
    if not spec.startswith("."):
        return spec  # @orbit/* or bare module -> untouched
    exists, target = resolve_target(spec, source)
    if exists:
        tpkg = pkg_of_file(target)
        spkg = pkg_of_file(source)
        if tpkg == spkg:
            return spec  # intra-package / intra-root -> keep relative
        if tpkg in packages:
            return f"@orbit/{tpkg}"
        # target is root scope but source is a package -> should not happen
        return spec
    # dangling: resolve via subpath map
    sub = subpath_of_dangling(target, source)
    if sub in subpath_to_pkg:
        return f"@orbit/{subpath_to_pkg[sub]}"
    sys.stderr.write(f"  !! UNRESOLVED: {source} -> {spec} (subpath={sub})\n")
    return spec

edges = {}  # sourcePkg -> set(targetPkg)
files_changed = 0
total_rewrites = 0

for f in targets:
    try:
        text = f.read_text(encoding="utf-8")
    except Exception as e:
        sys.stderr.write(f"  !! READ FAIL {f}: {e}\n")
        continue
    original = text
    spkg = pkg_of_file(f)

    def repl(m, pre_group=0):
        global total_rewrites
        pre = m.group(1)
        quote = m.group(2)
        spec = m.group(3)
        new = rewrite_spec(spec, f)
        if new != spec:
            total_rewrites += 1
            if spkg in packages:
                edges.setdefault(spkg, set())
                if new.startswith("@orbit/"):
                    edges[spkg].add(new[len("@orbit/"):])
        return pre + quote + new + quote

    text = RE_FROM.sub(repl, text)
    text = RE_SIDE.sub(repl, text)
    text = RE_DYN.sub(lambda m: m.group(1) + m.group(2) + rewrite_spec(m.group(3), f) + m.group(2) + m.group(4), text)

    if text != original:
        f.write_text(text, encoding="utf-8")
        files_changed += 1

# convert edges sets to sorted lists
edges_out = {k: sorted(v) for k, v in sorted(edges.items())}

out_path = ROOT / "scripts" / "_detected_edges.json"
out_path.write_text(json.dumps(edges_out, indent=2), encoding="utf-8")

print(f"Files changed: {files_changed}")
print(f"Total specs rewritten: {total_rewrites}")
print("Detected dependency edges (sourcePkg -> [targetPkgs]):")
for k, v in edges_out.items():
    print(f"  {k} -> {v}")
print(f"Edges written to {out_path}")
