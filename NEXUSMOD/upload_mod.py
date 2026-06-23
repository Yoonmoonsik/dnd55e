"""
Nexus Mods file uploader script.
Reads configuration from upload_config.json (or a path specified via --config).

Upload flow:
  1. Create upload session (single-part < 100 MiB, multipart >= 100 MiB)
  2. PUT file data to presigned URL(s)
  3. Finalise upload session
  4. Create mod file  — OR — create new mod file version (if mod_file_id is set)
"""

import argparse
import json
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from xml.etree import ElementTree as ET

import requests

BASE_URL = "https://api.nexusmods.com/v3"
MULTIPART_THRESHOLD = 100 * 1024 * 1024  # 100 MiB

def load_config(config_path: str) -> dict:
    path = Path(config_path)
    if not path.exists():
        sys.exit(f"[ERROR] Config file not found: {config_path}")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def make_headers(api_key: str) -> dict:
    return {"apikey": api_key, "Content-Type": "application/json"}


DEFAULT_PAK_PATH = (
    r"C:\Users\yoonm\AppData\Local\Larian Studios"
    r"\Baldur's Gate 3\Mods\DnD2024_897914ef-5c96-053c-44af-0be823f895fe.pak"
)


def create_zip_from_pak(pak_path: str) -> Path:
    """Zip the given .pak file into a temp directory and return the zip path."""
    pak = Path(pak_path)
    if not pak.exists():
        sys.exit(f"[ERROR] pak file not found: {pak_path}")
    tmp_dir = Path(tempfile.mkdtemp())
    zip_path = tmp_dir / f"{pak.stem}.zip"
    print(f"[INFO] Zipping pak  : {pak.name}")
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.write(pak, pak.name)
    print(f"[INFO] Created zip  : {zip_path}")
    return zip_path


def _decode_version64(v64: int) -> str:
    """Decode a Larian Version64 int64 to a dotted version string."""
    major    = (v64 >> 55) & 0x1FF
    minor    = (v64 >> 47) & 0xFF
    revision = (v64 >> 31) & 0xFFFF
    build    = v64 & 0x7FFFFFFF
    return f"{major}.{minor}.{revision}.{build}"


def read_version_from_meta(meta_path: Path) -> str:
    """Read Version64 from ModuleInfo in meta.lsx and return as dotted version string."""
    if not meta_path.exists():
        sys.exit(f"[ERROR] meta.lsx not found: {meta_path}")
    tree = ET.parse(meta_path)
    for node in tree.getroot().iter("node"):
        if node.get("id") == "ModuleInfo":
            for attr in node:
                if attr.get("id") == "Version64":
                    v64 = int(attr.get("value"))
                    version = _decode_version64(v64)
                    print(f"[INFO] Version64    : {v64}")
                    print(f"[INFO] Version      : {version}")
                    return version
    sys.exit("[ERROR] Version64 not found in ModuleInfo in meta.lsx")


def _parse_signed_headers(presigned_url: str) -> list[str]:
    """Extract the X-Amz-SignedHeaders list from a presigned URL."""
    qs = parse_qs(urlparse(presigned_url).query)
    raw = qs.get("X-Amz-SignedHeaders", [""])[0]
    return [h.strip() for h in raw.split(";") if h.strip()]


# ---------------------------------------------------------------------------
# Step 1 — create upload session
# ---------------------------------------------------------------------------

def create_upload_session(api_key: str, file_path: Path, debug: bool = False) -> dict:
    size_bytes = file_path.stat().st_size
    filename = file_path.name

    payload = {"size_bytes": size_bytes, "filename": filename}

    if size_bytes >= MULTIPART_THRESHOLD:
        print(f"[INFO] File is {size_bytes / 1024 / 1024:.1f} MiB — using multipart upload.")
        endpoint = f"{BASE_URL}/uploads/multipart"
    else:
        print(f"[INFO] File is {size_bytes / 1024 / 1024:.1f} MiB — using single-part upload.")
        endpoint = f"{BASE_URL}/uploads"

    resp = _post_with_retry(endpoint, make_headers(api_key), payload)
    data = resp.json()["data"]

    if debug:
        presigned = data.get("presigned_url", "")
        signed_headers = _parse_signed_headers(presigned)
        print(f"[DEBUG] Upload ID     : {data.get('id')}")
        print(f"[DEBUG] SignedHeaders : {signed_headers}")
        # Print URL with signature masked for safety
        masked = presigned.split("X-Amz-Signature=")[0] + "X-Amz-Signature=<masked>"
        print(f"[DEBUG] Presigned URL : {masked}")

    return data


# ---------------------------------------------------------------------------
# Step 2a — single-part upload
# ---------------------------------------------------------------------------

class _ProgressReader:
    """File-like wrapper with __len__ so requests uses Content-Length (not chunked).

    S3/R2 presigned PUTs reject chunked transfer encoding, which requests
    switches to automatically when given a generator or an object without __len__.
    """

    def __init__(self, file_obj, total: int):
        self._file = file_obj
        self._total = total
        self._done = 0

    def read(self, size: int = -1) -> bytes:
        chunk = self._file.read(size)
        if chunk:
            self._done += len(chunk)
            pct = self._done * 100 // self._total
            mb_done = self._done / 1024 / 1024
            mb_total = self._total / 1024 / 1024
            print(f"\r  {mb_done:.1f} MiB / {mb_total:.1f} MiB  ({pct}%)", end="", flush=True)
        return chunk

    def __len__(self) -> int:
        return self._total


def upload_single(presigned_url: str, file_path: Path, cfg: dict, debug: bool = False) -> None:
    signed_headers = _parse_signed_headers(presigned_url)

    # Nexus Mods signs presigned URLs with content-type and content-disposition.
    # Default to application/octet-stream; override via config if needed.
    put_headers: dict[str, str] = {}
    if "content-type" in signed_headers:
        ct = cfg.get("upload_content_type") or "application/octet-stream"
        put_headers["Content-Type"] = ct
        print(f"[INFO] Content-Type  : {ct}")
    if "content-disposition" in signed_headers:
        cd = cfg.get("upload_content_disposition") or f'attachment; filename="{file_path.name}"'
        put_headers["Content-Disposition"] = cd
        print(f"[INFO] Content-Disp  : {cd}")

    if debug:
        print(f"[DEBUG] PUT headers  : {put_headers}")

    print("[INFO] Reading file into memory …")
    data = file_path.read_bytes()
    print(f"[INFO] Uploading {len(data) / 1024 / 1024:.1f} MiB …")

    resp = requests.put(presigned_url, data=data, headers=put_headers, timeout=600)

    if resp.status_code not in (200, 204):
        sys.exit(f"[ERROR] Single-part PUT failed ({resp.status_code}):\n{resp.text}")

    print("[INFO] Upload complete.")


# ---------------------------------------------------------------------------
# Step 2b — multipart upload
# ---------------------------------------------------------------------------

def upload_multipart(session_data: dict, file_path: Path) -> None:
    part_size = session_data["part_size_bytes"]
    part_urls = session_data["part_presigned_urls"]
    complete_url = session_data["complete_presigned_url"]
    etags: list[tuple[int, str]] = []

    print(f"[INFO] Uploading {len(part_urls)} part(s) …")
    with open(file_path, "rb") as f:
        for part_number, url in enumerate(part_urls, start=1):
            chunk = f.read(part_size)
            print(f"  Part {part_number}/{len(part_urls)} …", end=" ", flush=True)
            resp = requests.put(url, data=chunk, timeout=600)
            if resp.status_code not in (200, 204):
                sys.exit(f"\n[ERROR] Part {part_number} PUT failed: {resp.status_code} {resp.text}")
            etag = resp.headers.get("ETag", "").strip('"')
            etags.append((part_number, etag))
            print("OK")

    xml_body = _build_complete_xml(etags)
    print("[INFO] Completing multipart upload …")
    resp = requests.post(complete_url, data=xml_body, timeout=60)
    if resp.status_code not in (200, 204):
        sys.exit(f"[ERROR] Complete multipart failed: {resp.status_code} {resp.text}")
    print("[INFO] Multipart upload complete.")


def _build_complete_xml(etags: list[tuple[int, str]]) -> str:
    root = ET.Element("CompleteMultipartUpload")
    for part_number, etag in etags:
        part = ET.SubElement(root, "Part")
        ET.SubElement(part, "PartNumber").text = str(part_number)
        ET.SubElement(part, "ETag").text = etag
    return ET.tostring(root, encoding="unicode")


# ---------------------------------------------------------------------------
# Step 3 — finalise upload
# ---------------------------------------------------------------------------

def finalise_upload(api_key: str, upload_id: str) -> None:
    print(f"[INFO] Finalising upload {upload_id} …")
    resp = requests.post(
        f"{BASE_URL}/uploads/{upload_id}/finalise",
        headers=make_headers(api_key),
        timeout=30,
    )
    _raise_for_status(resp, "finalise upload")
    print("[INFO] Upload finalised.")


def wait_for_available(api_key: str, upload_id: str, timeout: int = 120) -> None:
    print("[INFO] Waiting for upload to become available …")
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = requests.get(
            f"{BASE_URL}/uploads/{upload_id}",
            headers=make_headers(api_key),
            timeout=15,
        )
        _raise_for_status(resp, "get upload state")
        state = resp.json()["data"]["state"]
        if state == "available":
            print("[INFO] Upload is available.")
            return
        print(f"  State: {state} — waiting …")
        time.sleep(5)
    sys.exit("[ERROR] Upload did not become available within the timeout period.")


# ---------------------------------------------------------------------------
# Step 4a — create new mod file
# ---------------------------------------------------------------------------

def create_mod_file(api_key: str, upload_id: str, cfg: dict) -> dict:
    print("[INFO] Creating mod file …")
    payload = {
        "upload_id": upload_id,
        "mod_id": cfg["mod_id"],
        "name": cfg["name"],
        "version": cfg["version"],
        "file_category": cfg["file_category"],
    }
    _add_optional(payload, cfg, "description")
    _add_optional(payload, cfg, "primary_mod_manager_download")
    _add_optional(payload, cfg, "allow_mod_manager_download")
    _add_optional(payload, cfg, "show_requirements_pop_up")

    resp = requests.post(f"{BASE_URL}/mod-files", headers=make_headers(api_key), json=payload, timeout=30)
    _raise_for_status(resp, "create mod file")
    return resp.json()["data"]


# ---------------------------------------------------------------------------
# Step 4b — create new version of an existing mod file
# ---------------------------------------------------------------------------

def create_mod_file_version(api_key: str, upload_id: str, mod_file_id: str, cfg: dict) -> dict:
    print(f"[INFO] Creating new version for mod file {mod_file_id} …")
    payload = {
        "upload_id": upload_id,
        "name": cfg["name"],
        "version": cfg["version"],
        "file_category": cfg["file_category"],
    }
    _add_optional(payload, cfg, "description")
    _add_optional(payload, cfg, "primary_mod_manager_download")
    _add_optional(payload, cfg, "allow_mod_manager_download")
    _add_optional(payload, cfg, "show_requirements_pop_up")
    _add_optional(payload, cfg, "archive_existing_file")
    _add_optional(payload, cfg, "previous_version_id")

    resp = requests.post(
        f"{BASE_URL}/mod-files/{mod_file_id}/versions",
        headers=make_headers(api_key),
        json=payload,
        timeout=30,
    )
    _raise_for_status(resp, "create mod file version")
    return resp.json()["data"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _add_optional(payload: dict, cfg: dict, key: str) -> None:
    if cfg.get(key) is not None:
        payload[key] = cfg[key]


def _post_with_retry(url: str, headers: dict, payload: dict, max_retries: int = 5) -> requests.Response:
    """POST with exponential backoff on 429 rate limit responses."""
    wait = 60  # minimum 60s wait regardless of Retry-After
    for attempt in range(max_retries):
        resp = requests.post(url, headers=headers, json=payload, timeout=30)
        if resp.status_code != 429:
            _raise_for_status(resp, f"POST {url}")
            return resp
        retry_after = max(int(resp.headers.get("Retry-After", 0)), wait)
        print(f"[WARN] Rate limited (429). Waiting {retry_after}s before retry {attempt + 1}/{max_retries} …")
        time.sleep(retry_after)
        wait = min(wait * 2, 300)
    sys.exit("[ERROR] Rate limit not resolved after maximum retries.")


def _raise_for_status(resp: requests.Response, action: str) -> None:
    if not resp.ok:
        try:
            detail = resp.json()
        except Exception:
            detail = resp.text
        sys.exit(f"[ERROR] {action} failed ({resp.status_code}): {detail}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Upload a mod file to Nexus Mods.")
    parser.add_argument(
        "--config",
        default=Path(__file__).parent / "upload_config.json",
        help="Path to the JSON configuration file (default: upload_config.json next to this script).",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Print presigned URL info and request headers for troubleshooting.",
    )
    args = parser.parse_args()

    cfg = load_config(str(args.config))

    required = ["api_key", "name", "file_category"]
    missing = [k for k in required if not cfg.get(k)]
    if missing:
        sys.exit(f"[ERROR] Missing required config fields: {', '.join(missing)}")

    if cfg["file_category"] not in ("main", "optional", "miscellaneous"):
        sys.exit("[ERROR] file_category must be one of: main, optional, miscellaneous")

    pak_path = cfg.get("pak_path", DEFAULT_PAK_PATH)
    file_path = create_zip_from_pak(pak_path)

    meta_lsx = Path(__file__).parent.parent / "Mods" / "DnD2024_897914ef-5c96-053c-44af-0be823f895fe" / "meta.lsx"
    cfg["version"] = read_version_from_meta(meta_lsx)

    api_key = cfg["api_key"]
    mod_file_id = cfg.get("mod_file_id")

    if not mod_file_id and not cfg.get("mod_id"):
        sys.exit("[ERROR] Either 'mod_id' (for a new file) or 'mod_file_id' (for a new version) must be set.")

    # 1. Create upload session
    session = create_upload_session(api_key, file_path, debug=args.debug)
    upload_id = session["id"]

    # 2. Upload file
    if "part_presigned_urls" in session:
        upload_multipart(session, file_path)
    else:
        upload_single(session["presigned_url"], file_path, cfg, debug=args.debug)

    # 3. Finalise
    finalise_upload(api_key, upload_id)
    wait_for_available(api_key, upload_id)

    # 4. Create mod file / version
    if mod_file_id:
        result = create_mod_file_version(api_key, upload_id, mod_file_id, cfg)
    else:
        result = create_mod_file(api_key, upload_id, cfg)

    file_path.unlink(missing_ok=True)
    file_path.parent.rmdir()

    print("\n[SUCCESS] Upload completed.")
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
