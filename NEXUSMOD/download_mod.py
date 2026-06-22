"""
Nexus Mods latest-file downloader + localization extractor.

Pipeline (all steps run by default):
  1. GET mod file list  →  pick newest 'main' file
  2. Download zip       →  NEXUSMOD/TEMP/
  3. Extract zip        →  NEXUSMOD/TEMP/  (zip deleted)
  4. Extract .pak files →  NEXUSMOD/TEMP/<pak_stem>/  via Divine.exe
  5. Find Localization* dirs inside extracted pak content
  6. Copy every .xml found there →  NEXUSMOD/TEMP/localization_xml/<lang>/

Requires a Nexus Mods API key (free account):
  https://www.nexusmods.com/settings/api-keys
"""

import argparse
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import requests

BASE_URL_V1   = "https://api.nexusmods.com/v1"
DEFAULT_GAME  = "baldursgate3"
DEFAULT_MOD_ID = "22245"
SCRIPT_DIR    = Path(__file__).parent
PROJECT_DIR   = SCRIPT_DIR.parent
DEFAULT_TEMP  = SCRIPT_DIR / "TEMP"
DIVINE_EXE    = Path(r"d:\BG3\응용프로그램\Packed\Tools\Divine.exe")
DEFAULT_KR_DEST = PROJECT_DIR / "Mods" / "DnD2024_897914ef-5c96-053c-44af-0be823f895fe" / "Localization" / "Korean"
APP_NAME      = "NexusModsDownloader"
APP_VERSION   = "1.0.0"


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------

def load_config(config_path: str) -> dict:
    path = Path(config_path)
    if not path.exists():
        sys.exit(f"[ERROR] Config file not found: {config_path}")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _api_headers(api_key: str) -> dict:
    return {
        "apikey": api_key,
        "Application-Name": APP_NAME,
        "Application-Version": APP_VERSION,
    }


def get_mod_files(api_key: str, game: str, mod_id: str) -> list[dict]:
    url = f"{BASE_URL_V1}/games/{game}/mods/{mod_id}/files.json"
    resp = requests.get(url, headers=_api_headers(api_key), timeout=30)
    if not resp.ok:
        sys.exit(f"[ERROR] Failed to get mod files ({resp.status_code}): {resp.text}")
    return resp.json().get("files", [])


def pick_latest_file(files: list[dict]) -> dict:
    """Return the most recently uploaded main/update file."""
    MAIN_IDS   = {1}
    UPDATE_IDS = {2}
    SKIP_IDS   = {4, 6, 7}
    MAIN_NAMES   = {"main", "main files", "main file"}
    UPDATE_NAMES = {"update", "update files", "updates"}
    SKIP_NAMES   = {"old_version", "old version", "removed", "deleted"}

    def cid(f):
        v = f.get("category_id")
        return int(v) if v is not None else None

    def cname(f):
        return str(f.get("category_name", "")).lower().strip()

    def is_main(f):   return (cid(f) in MAIN_IDS)   or (cid(f) is None and cname(f) in MAIN_NAMES)
    def is_update(f): return (cid(f) in UPDATE_IDS) or (cid(f) is None and cname(f) in UPDATE_NAMES)
    def is_skip(f):   return (cid(f) in SKIP_IDS)   or (cid(f) is None and cname(f) in SKIP_NAMES)

    for pred in (is_main, is_update):
        cands = [f for f in files if pred(f)]
        if cands:
            return max(cands, key=lambda f: f.get("uploaded_timestamp", 0))

    cands = [f for f in files if not is_skip(f)]
    if cands:
        print("[WARN] No main/update files — picking newest non-removed file.")
        return max(cands, key=lambda f: f.get("uploaded_timestamp", 0))

    sys.exit("[ERROR] No downloadable files found.")


def get_download_url(api_key: str, game: str, mod_id: str, file_id: int) -> str:
    url = f"{BASE_URL_V1}/games/{game}/mods/{mod_id}/files/{file_id}/download_link.json"
    resp = requests.get(url, headers=_api_headers(api_key), timeout=30)
    if not resp.ok:
        sys.exit(f"[ERROR] Failed to get download link ({resp.status_code}): {resp.text}")
    links = resp.json()
    if not links:
        sys.exit("[ERROR] No download links returned.")
    return links[0]["URI"]


# ---------------------------------------------------------------------------
# Step 1 — download
# ---------------------------------------------------------------------------

def download_file(url: str, dest_dir: Path, filename: str) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / filename
    print(f"[1/4] Downloading → {dest}")
    with requests.get(url, stream=True, timeout=600) as resp:
        if not resp.ok:
            sys.exit(f"[ERROR] Download failed ({resp.status_code}): {resp.text}")
        total = int(resp.headers.get("Content-Length", 0))
        done = 0
        with open(dest, "wb") as f:
            for chunk in resp.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)
                    done += len(chunk)
                    if total:
                        pct = done * 100 // total
                        print(f"\r      {done/1024/1024:.1f} / {total/1024/1024:.1f} MiB  ({pct}%)",
                              end="", flush=True)
    print()
    return dest


# ---------------------------------------------------------------------------
# Step 2 — extract zip
# ---------------------------------------------------------------------------

def extract_zip(zip_path: Path, dest_dir: Path) -> None:
    print(f"[2/4] Extracting zip → {dest_dir}")
    with zipfile.ZipFile(zip_path, "r") as zf:
        members = zf.namelist()
        for i, m in enumerate(members, 1):
            zf.extract(m, dest_dir)
            print(f"\r      {i}/{len(members)} files", end="", flush=True)
    print()
    zip_path.unlink()
    print(f"      Zip deleted.")


# ---------------------------------------------------------------------------
# Step 3 — extract .pak files via Divine.exe
# ---------------------------------------------------------------------------

def extract_paks(search_dir: Path) -> list[Path]:
    """Extract every .pak in search_dir; return list of extraction root dirs."""
    if not DIVINE_EXE.exists():
        sys.exit(f"[ERROR] Divine.exe not found: {DIVINE_EXE}")

    paks = list(search_dir.rglob("*.pak"))
    if not paks:
        print("[3/4] No .pak files found.")
        return []

    print(f"[3/4] Extracting {len(paks)} .pak file(s) via Divine.exe …")
    extracted_roots: list[Path] = []
    for pak in paks:
        dest = pak.parent / pak.stem
        dest.mkdir(exist_ok=True)
        print(f"      {pak.name} → {dest.name}/")
        result = subprocess.run(
            [str(DIVINE_EXE), "-g", "bg3", "-a", "extract-package", "-s", str(pak), "-d", str(dest)],
            capture_output=True,
            text=True,
        )
        output = (result.stdout + result.stderr).strip()
        if result.returncode != 0:
            print(f"[ERROR] Divine.exe failed ({pak.name}):\n{output}")
        else:
            print(f"      {output}")
            extracted_roots.append(dest)

    return extracted_roots


# ---------------------------------------------------------------------------
# Step 4 — find Localization dirs and collect XMLs
# ---------------------------------------------------------------------------

def collect_localization_xmls(
    pak_roots: list[Path],
    xml_out: Path,
    name_filter: str | None = None,
) -> list[Path]:
    """Search each pak extraction root for Localization* dirs; copy XMLs to xml_out.

    name_filter: if set, only copy XMLs whose filename contains this string (case-insensitive).
    """
    print(f"[4/4] Searching for localization XML files …")
    collected: list[Path] = []

    for root in pak_roots:
        loc_dirs = [
            d for d in root.rglob("*")
            if d.is_dir() and "locali" in d.name.lower()
        ]

        if not loc_dirs:
            print(f"      No localization folder in: {root.name}/")
            continue

        for loc_dir in loc_dirs:
            xmls = list(loc_dir.rglob("*.xml"))
            if not xmls:
                continue
            for xml in xmls:
                if name_filter and name_filter.lower() not in xml.name.lower():
                    print(f"      Skipped : {xml.name}")
                    continue
                rel = xml.relative_to(loc_dir)
                out_name = (name_filter.lower() + ".xml") if name_filter else xml.name
                out = xml_out / rel.parent / out_name
                out.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(xml, out)
                print(f"      Copied  : {rel} → {out.name}")
                collected.append(out)

    return collected


def cleanup_temp(temp_dir: Path, keep_dir: Path) -> None:
    """Delete everything in temp_dir except keep_dir."""
    print(f"[5/5] Cleaning up {temp_dir} …")
    for item in temp_dir.iterdir():
        if item.resolve() == keep_dir.resolve():
            continue
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()
        print(f"      Deleted: {item.name}")
    print("      Done.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    default_config = SCRIPT_DIR / "upload_config.json"

    parser = argparse.ArgumentParser(
        description="Download latest Nexus Mods file, extract zip+pak, collect localization XMLs."
    )
    parser.add_argument("--config", default=str(default_config),
                        help="Config JSON with 'api_key'.")
    parser.add_argument("--api-key",  help="Nexus Mods API key (overrides config).")
    parser.add_argument("--game",     default=DEFAULT_GAME,
                        help=f"Game domain (default: {DEFAULT_GAME}).")
    parser.add_argument("--mod-id",   default=DEFAULT_MOD_ID,
                        help=f"Mod ID (default: {DEFAULT_MOD_ID}).")
    parser.add_argument("--temp-dir", default=str(DEFAULT_TEMP),
                        help=f"Working directory (default: {DEFAULT_TEMP}).")
    parser.add_argument("--xml-out",    default=None,
                        help="Where to copy localization XMLs (default: TEMP/localization_xml/).")
    parser.add_argument("--xml-filter", default="korean",
                        help="Only copy XMLs whose filename contains this string (default: 'korean'). Pass '' to copy all.")
    parser.add_argument("--cleanup",    action="store_true", default=True,
                        help="Delete everything in TEMP except the collected XMLs after extraction (default: on).")
    parser.add_argument("--no-cleanup", action="store_false", dest="cleanup",
                        help="Keep all intermediate files in TEMP.")
    parser.add_argument("--dest", default=str(DEFAULT_KR_DEST),
                        help=f"Final destination for the collected XMLs (default: {DEFAULT_KR_DEST}).")
    parser.add_argument("--list",       action="store_true",
                        help="List available files and exit.")
    args = parser.parse_args()

    # --- API key ---
    api_key = args.api_key
    if not api_key and Path(args.config).exists():
        api_key = load_config(args.config).get("api_key")
    if not api_key:
        sys.exit("[ERROR] No API key. Use --api-key or set 'api_key' in the config file.")

    temp_dir = Path(args.temp_dir)
    xml_out  = Path(args.xml_out) if args.xml_out else temp_dir / "localization_xml"

    print(f"[INFO] Game    : {args.game}")
    print(f"[INFO] Mod ID  : {args.mod_id}")
    print(f"[INFO] Temp dir: {temp_dir}")

    # --- list mode ---
    files = get_mod_files(api_key, args.game, args.mod_id)
    print(f"[INFO] {len(files)} file(s) on this mod page.")

    if args.list:
        for f in sorted(files, key=lambda x: x.get("uploaded_timestamp", 0), reverse=True):
            cat = f"{f.get('category_name','?')} (id={f.get('category_id','?')})"
            print(f"  [{cat:30s}] file_id={f['file_id']}  v{f.get('version','?'):10s}  {f.get('file_name','?')}")
        return

    # --- pick file ---
    chosen = pick_latest_file(files)
    print(f"[INFO] Selected: {chosen.get('file_name')} (v{chosen.get('version')}, {chosen.get('size_kb',0)} KB)\n")

    # Step 1 — download
    dl_url = get_download_url(api_key, args.game, args.mod_id, chosen["file_id"])
    dest   = download_file(dl_url, temp_dir, chosen["file_name"])

    # Step 2 — extract zip
    if dest.suffix.lower() == ".zip":
        extract_zip(dest, temp_dir)
    else:
        print(f"[2/4] Skipped (not a zip): {dest.name}")

    # Step 3 — extract pak
    pak_roots = extract_paks(temp_dir)

    # Step 4 — collect localization XMLs
    if pak_roots:
        xmls = collect_localization_xmls(pak_roots, xml_out, name_filter=args.xml_filter)
        if xmls:
            print(f"\n[INFO] {len(xmls)} XML file(s) copied to: {xml_out}")
        else:
            print(f"\n[WARN] No localization XML files matched.")
    else:
        print("[WARN] No pak files were successfully extracted.")
        xmls = []

    # Step 5 — cleanup
    if args.cleanup:
        cleanup_temp(temp_dir, keep_dir=xml_out)

    # Step 5b — move to final destination
    dest_dir = Path(args.dest)
    if xmls and dest_dir:
        dest_dir.mkdir(parents=True, exist_ok=True)
        moved: list[Path] = []
        for x in xmls:
            final = dest_dir / x.name
            shutil.move(str(x), final)
            print(f"[INFO] Moved: {x.name} → {final}")
            moved.append(final)
        # remove now-empty localization_xml tree
        shutil.rmtree(xml_out, ignore_errors=True)
        print(f"\n[SUCCESS] Final XML(s):")
        for f in moved:
            print(f"  {f}")
    elif xmls:
        print(f"\n[SUCCESS] Final XML(s):")
        for x in xmls:
            print(f"  {x}")
    else:
        print(f"\n[SUCCESS] Done: {temp_dir}")


if __name__ == "__main__":
    main()
