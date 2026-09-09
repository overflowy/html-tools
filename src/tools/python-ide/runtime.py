"""The Python half of the Interpreter worker.

Written into the interpreter's filesystem at boot and imported once. Owns
what `python file.py` would: a fresh __main__, sys.path and sys.argv set the
way CPython sets them, stdin that reads the Stdin text first and then asks
the Terminal (through JSPI, where the browser has it), tracebacks with the
runtime's own frames removed, and the REPL. The host side is `pyide_host`,
a JavaScript module the worker registers before importing this.
"""

import builtins
import importlib
import io
import json
import os
import sys
import traceback
import zipfile
from pyodide.ffi import can_run_sync, run_sync, to_js
from pyodide.console import Console, repr_shorten

import pyide_host

PROJECT_ROOT = "/project"
RUNTIME_FILES = {__file__, "/pyide/pyide_mpl.py"}

# sys.path as Pyodide leaves it after boot, minus its "" entry (the cwd),
# which CPython adds for the REPL but never for a script.
_base_path = [p for p in sys.path if p != ""]
_base_environ = dict(os.environ)

# Bytecode caches go beside the runtime, never into the Project: a
# __pycache__ there would be a folder the Tree does not know, and one that
# keeps a renamed or deleted package's folder alive as a namespace package.
sys.pycache_prefix = "/pyide/pycache"


class HostStdin(io.TextIOBase):
    """sys.stdin: the Stdin text line by line, then the Terminal, then EOF."""

    def __init__(self):
        self.preset = ""

    def readable(self):
        return True

    def isatty(self):
        return False

    def fileno(self):
        raise io.UnsupportedOperation("fileno")

    def _line(self):
        if self.preset:
            i = self.preset.find("\n")
            if i == -1:
                line, self.preset = self.preset, ""
            else:
                line, self.preset = self.preset[: i + 1], self.preset[i + 1 :]
            return line
        if not can_run_sync():
            pyide_host.inputUnavailable()
            return ""
        line = run_sync(pyide_host.requestInput())
        return "" if line is None else str(line)

    def readline(self, size: int | None = -1):
        line = self._line()
        if size is not None and size >= 0:
            line = line[:size]
        return line

    def read(self, size: int | None = -1):
        if size is None or size < 0:
            parts = []
            while True:
                line = self._line()
                if not line:
                    return "".join(parts)
                parts.append(line)
        out = ""
        while len(out) < size:
            line = self._line()
            if not line:
                break
            out += line
        return out

    def __iter__(self):
        return self

    def __next__(self):
        line = self._line()
        if not line:
            raise StopIteration
        return line


stdin = HostStdin()
sys.stdin = stdin
sys.__stdin__ = stdin


def _configure_streams():
    # A terminal is line buffered; without this, output arrives at exit.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            try:
                reconfigure(line_buffering=True)
            except Exception:
                pass


_configure_streams()


def _flush():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            pass


def _main_dict():
    import __main__

    return __main__.__dict__


def _reset_main(path):
    main = _main_dict()
    main.clear()
    main.update(
        {
            "__name__": "__main__",
            "__file__": path,
            "__builtins__": builtins,
            "__doc__": None,
            "__package__": None,
            "__spec__": None,
            "__loader__": None,
            "__annotations__": {},
        }
    )
    return main


def _drop_project_modules():
    """Forget every module imported from the Project, so the next Run re-reads it.

    A namespace package (a folder without __init__.py) has no __file__, only
    a __path__; it is dropped by that, or a folder renamed away would still
    import as an empty module. That __path__ is recomputed from the parent
    package's on every read, so children go before parents, and one whose
    path cannot be read (its folder or its parent gone) is dead and goes too.
    """
    root = PROJECT_ROOT + "/"
    for name, module in sorted(sys.modules.items(), key=lambda item: -item[0].count(".")):
        if name == "__main__":
            continue
        file = getattr(module, "__file__", None)
        if isinstance(file, str):
            if file.startswith(root):
                del sys.modules[name]
            continue
        if getattr(module, "__path__", None) is None:
            continue
        try:
            paths = [str(p) for p in module.__path__]
        except Exception:
            paths = []
        if not paths or any(p == PROJECT_ROOT or p.startswith(root) for p in paths):
            del sys.modules[name]
    importlib.invalidate_caches()


def _clean_traceback(tb):
    """Drop the runtime's own frames from the top of a traceback."""
    while tb is not None and tb.tb_frame.f_code.co_filename in RUNTIME_FILES:
        tb = tb.tb_next
    return tb


def _print_exception(exc):
    tb = _clean_traceback(exc.__traceback__)
    if isinstance(exc, SyntaxError) and exc.filename in RUNTIME_FILES:
        tb = None
    _flush()
    traceback.print_exception(type(exc), exc, tb, file=sys.stderr)
    _flush()


def _snapshot():
    """(mtime, size) of every file under the Project, and every folder, to see what a Run changed."""
    files = {}
    dirs = []
    for dirpath, dirnames, filenames in os.walk(PROJECT_ROOT):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for name in dirnames:
            dirs.append(os.path.relpath(os.path.join(dirpath, name), PROJECT_ROOT))
        for name in filenames:
            full = os.path.join(dirpath, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            files[os.path.relpath(full, PROJECT_ROOT)] = (st.st_mtime_ns, st.st_size)
    return files, sorted(dirs)


MAX_SYNC_BYTES = 20 * 1024 * 1024


def _changes(before, after):
    changed = []
    skipped = []
    for rel, stamp in after.items():
        if before.get(rel) == stamp:
            continue
        full = os.path.join(PROJECT_ROOT, rel)
        if stamp[1] > MAX_SYNC_BYTES:
            skipped.append(rel)
            continue
        with open(full, "rb") as f:
            changed.append({"path": rel, "data": to_js(f.read())})
    removed = [rel for rel in before if rel not in after]
    return changed, removed, skipped


def run_file():
    """Run a file of the Project the way `python path` would. Arguments come from the host."""
    args = pyide_host.runArgs.to_py()
    path = args["path"]
    stdin.preset = args.get("stdin") or ""
    os.chdir(PROJECT_ROOT)
    sys.path[:] = [os.path.dirname(path)] + _base_path
    sys.argv = [path] + list(args.get("argv") or [])
    os.environ.clear()
    os.environ.update(_base_environ)
    os.environ.update(args.get("env") or {})
    _drop_project_modules()
    main = _reset_main(path)
    before, _ = _snapshot()
    exit_code = 0
    try:
        with open(path, "rb") as f:
            source = f.read()
        code = compile(source, path, "exec")
        exec(code, main)
    except SystemExit as e:
        code_ = e.code
        if code_ is None:
            exit_code = 0
        elif isinstance(code_, int):
            exit_code = code_
        else:
            _flush()
            print(code_, file=sys.stderr)
            exit_code = 1
    except BaseException as e:  # noqa: BLE001
        _print_exception(e)
        exit_code = 1
    finally:
        _flush()
        stdin.preset = ""
        sys.path[:] = [""] + _base_path
    after, folders = _snapshot()
    changed, removed, skipped = _changes(before, after)
    return to_js(
        {"exit": exit_code, "changed": changed, "removed": removed, "skipped": skipped, "folders": folders},
        dict_converter=pyide_host.toObject,
    )


# ---------------- packages ----------------


async def install(specs):
    import micropip

    await micropip.install(list(specs))
    return environment()


async def uninstall(names):
    import micropip
    import shutil
    import sysconfig
    import importlib

    micropip.uninstall(list(names))
    # A package the lockfile installed carries PYODIDE_URL and PYODIDE_SHA256
    # files its RECORD never listed; uninstall leaves the dist-info directory
    # behind with just those, and freeze then trips over a nameless distribution.
    for key in ("purelib", "platlib"):
        path = sysconfig.get_paths().get(key)
        if not path or not os.path.isdir(path):
            continue
        for entry in os.listdir(path):
            full = os.path.join(path, entry)
            if entry.endswith(".dist-info") and os.path.isdir(full) and not os.path.exists(os.path.join(full, "METADATA")):
                shutil.rmtree(full, ignore_errors=True)
    importlib.invalidate_caches()
    return environment()


def environment():
    """The Lock and the installed package list, as JSON for the host."""
    import micropip

    packages = []
    for item in micropip.list().values():
        packages.append({"name": item.name, "version": item.version, "source": item.source})
    return json.dumps({"lock": micropip.freeze(), "packages": packages})


SKIP_DIRS = {"__pycache__", "tests", "test", "testing", "_tests"}
MAX_MIRROR_FILE = 2 * 1024 * 1024


def _mirror_dir(root, prefix, out):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.endswith(".dist-info")]
        rel = os.path.relpath(dirpath, root)
        for name in filenames:
            if not (name.endswith((".py", ".pyi")) or name == "py.typed"):
                continue
            full = os.path.join(dirpath, name)
            try:
                if os.path.getsize(full) > MAX_MIRROR_FILE:
                    continue
                with open(full, encoding="utf-8", errors="replace") as f:
                    text = f.read()
            except OSError:
                continue
            key = prefix if rel == "." else prefix + "/" + rel
            out[key + "/" + name] = text


def _mirror_zip(zip_path, inner, prefix, out):
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            if not info.filename.startswith(inner + "/"):
                continue
            name = info.filename
            if name.endswith("/") or "__pycache__" in name:
                continue
            if not (name.endswith((".py", ".pyi")) or name.endswith("/py.typed")):
                continue
            out[prefix + "/" + name] = z.read(info).decode("utf-8", "replace")


def mirror():
    """Sources of everything installed, for the Checker's virtual filesystem."""
    import sysconfig

    out = {}
    seen = set()
    for key in ("purelib", "platlib"):
        path = sysconfig.get_paths().get(key)
        if path and path not in seen and os.path.isdir(path):
            seen.add(path)
            _mirror_dir(path, "/site-packages", out)
    # The pyodide package lives in the standard library zip, not site-packages.
    import pyodide

    file = pyodide.__file__ or ""
    if ".zip/" in file:
        zip_path = file.split(".zip/", 1)[0] + ".zip"
        for pkg in ("pyodide", "_pyodide"):
            _mirror_zip(zip_path, pkg, "/site-packages", out)
    elif file:
        for pkg in ("pyodide", "_pyodide"):
            root = os.path.join(os.path.dirname(os.path.dirname(file)), pkg)
            if os.path.isdir(root):
                _mirror_dir(root, "/site-packages/" + pkg, out)
    return to_js(out, dict_converter=pyide_host.toObject)


# ---------------- REPL ----------------

_console = None


def _get_console():
    global _console
    if _console is None:
        _console = Console(globals=_main_dict(), filename="<console>")
    return _console


async def repl(line):
    console = _get_console()
    os.chdir(PROJECT_ROOT)
    fut = console.push(line)
    if fut.syntax_check == "incomplete":
        return json.dumps({"status": "incomplete"})
    if fut.syntax_check == "syntax-error":
        return json.dumps({"status": "error", "text": fut.formatted_error or ""})
    try:
        value = await fut
    except SystemExit as e:
        return json.dumps({"status": "exit", "text": str(e.code) if e.code not in (None, 0) else ""})
    except BaseException:  # noqa: BLE001
        _flush()
        return json.dumps({"status": "error", "text": fut.formatted_error or traceback.format_exc()})
    _flush()
    if value is None:
        return json.dumps({"status": "ok"})
    return json.dumps({"status": "ok", "text": repr_shorten(value, separator="\n<long output truncated>\n")})


def complete(source):
    completions, start = _get_console().complete(source)
    return json.dumps({"completions": completions, "start": start})


def reset_repl():
    """A new console over the same __main__, forgetting any half-typed statement."""
    global _console
    _console = None
