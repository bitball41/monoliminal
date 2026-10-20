#!/usr/bin/env python3
"""Read-only Supabase export. Only authenticated, encrypted archives may leave staging."""
import argparse
import base64
import datetime
import email.utils
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SETTINGS = json.loads((ROOT / "config/migration-source.json").read_text())
REQUIRED = ("LIMINAL_SOURCE_DB_URL", "LIMINAL_SOURCE_STORAGE_KEY",
            "LIMINAL_SOURCE_ACCESS_TOKEN", "LIMINAL_BACKUP_PASSPHRASE")
MANAGED = {"auth", "storage", "realtime", "extensions", "graphql", "graphql_public", "vault", "supabase_migrations"}
OBJECT_FIELDS = ("bucket_id", "name", "version", "updated_at", "metadata")


class BackupError(Exception):
    """A deliberately credential-free error suitable for Actions logs."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward source credentials to another origin.


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def storage_headers(key):
    if key.startswith("sb_secret_") and not re.search(r"\s", key):
        return {"apikey": key}
    try:
        payload = key.split(".")[1]
        role = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["role"]
        if role == "service_role" and len(key.split(".")) == 3 and not re.search(r"\s", key):
            return {"apikey": key, "Authorization": "Bearer " + key}
    except (ValueError, KeyError, IndexError, UnicodeError):
        pass
    raise BackupError("Storage export requires a server secret or service_role key, never a public key.")


def credentials(env, *, metadata_only=False):
    required = ("LIMINAL_SOURCE_ACCESS_TOKEN", "LIMINAL_BACKUP_PASSPHRASE") if metadata_only else REQUIRED
    missing = [name for name in required if not env.get(name)]
    if missing:
        raise BackupError("Missing repository secrets: " + ", ".join(missing))
    if len(env["LIMINAL_BACKUP_PASSPHRASE"]) < 24:
        raise BackupError("LIMINAL_BACKUP_PASSPHRASE must contain at least 24 characters.")
    if any(c in env["LIMINAL_BACKUP_PASSPHRASE"] for c in ("\n", "\r", "\0")):
        raise BackupError("Use a single-line backup passphrase.")
    if metadata_only:
        return {}  # Management requests use only the fixed source project ref below.
    url = urllib.parse.urlsplit(env["LIMINAL_SOURCE_DB_URL"])
    ref = SETTINGS["projectRef"]
    user = urllib.parse.unquote(url.username or "")
    host = url.hostname or ""
    direct = host == "db." + ref + ".supabase.co" and user == "postgres"
    pooler = host.endswith(".pooler.supabase.com") and user == "postgres." + ref
    if url.scheme not in ("postgres", "postgresql") or not (direct or pooler):
        raise BackupError("The database connection must point to the configured ORIGINAL Liminal project.")
    if not url.password or url.path not in ("", "/postgres") or (pooler and url.port != 5432):
        raise BackupError("Use the source project's postgres connection, with a password and session-pooler port 5432.")
    options = urllib.parse.parse_qs(url.query)
    sslmode = options.get("sslmode", ["require"])[0]
    if sslmode not in ("require", "verify-ca", "verify-full"):
        raise BackupError("Database TLS is required.")
    storage_headers(env["LIMINAL_SOURCE_STORAGE_KEY"])
    return {"PGHOST": host, "PGPORT": str(url.port or 5432), "PGUSER": user,
            "PGPASSWORD": urllib.parse.unquote(url.password), "PGDATABASE": "postgres",
            "PGSSLMODE": sslmode, "PGCONNECT_TIMEOUT": "20",
            "PGAPPNAME": "liminal-readonly-backup",
            "PGOPTIONS": "-c default_transaction_read_only=on -c statement_timeout=300000"}


def run(command, *, env=None, cwd=None, output=None, input_bytes=None, timeout=1800):
    try:
        with (output.open("wb") if output else open(os.devnull, "wb")) as target:
            result = subprocess.run(command, env=env, cwd=cwd, input=input_bytes,
                                    stdout=target, stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise BackupError("A required export/encryption command could not finish.") from None
    if result.returncode:
        # CLI errors can include connection strings, SQL rows or response bodies.
        raise BackupError("An export/encryption command failed; no raw diagnostics were published.")


def query(sql, env):
    try:
        result = subprocess.run(["psql", "--no-psqlrc", "--no-align", "--tuples-only",
                                 "--set", "ON_ERROR_STOP=1", "--command", sql],
                                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=600, check=False)
        if result.returncode:
            raise BackupError("Read-only database inventory failed.")
        return json.loads(result.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise BackupError("Read-only database inventory could not be decoded.") from None


def install_cli(destination):
    version = SETTINGS["supabaseCliVersion"]
    url = ("https://github.com/supabase/cli/releases/download/v" + version +
           "/supabase_" + version + "_linux_amd64.tar.gz")
    archive = destination / "cli.tar.gz"
    with urllib.request.urlopen(url, timeout=120) as response, archive.open("wb") as f:
        shutil.copyfileobj(response, f)
    if digest(archive) != SETTINGS["supabaseCliLinuxAmd64Sha256"]:
        raise BackupError("Supabase CLI checksum differs from the pinned release.")
    with tarfile.open(archive) as tar:
        member = tar.getmember("supabase")
        if not member.isfile():
            raise BackupError("Invalid Supabase CLI archive.")
        with tar.extractfile(member) as source, (destination / "supabase").open("wb") as target:
            shutil.copyfileobj(source, target)
        if (destination / "supabase").stat().st_size != member.size:
            raise BackupError("Supabase CLI extraction was incomplete.")
    (destination / "supabase").chmod(0o700)
    return str(destination / "supabase")


class Api:
    def __init__(self, origin, headers, opener=None, pause=time.sleep):
        self.origin = origin.rstrip("/")
        self.headers = headers
        self.opener = opener or urllib.request.build_opener(NoRedirect())
        self.pause = pause

    def fetch(self, route, destination=None):
        if not route.startswith("/") or route.startswith("//"):
            raise BackupError("Invalid export route.")
        for attempt in range(8):
            delay = min(2 ** attempt, 30)
            try:
                request = urllib.request.Request(self.origin + route, headers=self.headers, method="GET")
                with self.opener.open(request, timeout=90) as response:
                    if destination:
                        h = hashlib.sha256()
                        total = 0
                        with destination.open("wb") as f:
                            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                                f.write(chunk)
                                h.update(chunk)
                                total += len(chunk)
                        return {"bytes": total, "sha256": h.hexdigest()}
                    return json.loads(response.read())
            except urllib.error.HTTPError as error:
                if error.code not in (429, 500, 502, 503, 504) or attempt == 7:
                    raise BackupError("Authenticated export request failed (HTTP " + str(error.code) + ").") from None
                retry_after = error.headers.get("Retry-After", "")
                try:
                    seconds = float(retry_after)
                except ValueError:
                    try:
                        seconds = (email.utils.parsedate_to_datetime(retry_after) -
                                   datetime.datetime.now(datetime.timezone.utc)).total_seconds()
                    except (TypeError, ValueError):
                        seconds = 0
                delay = max(delay, min(60, seconds))
                error.close()
            except (OSError, ValueError):
                if attempt == 7:
                    raise BackupError("Authenticated export request could not finish.") from None
            self.pause(delay)
        raise BackupError("Authenticated export request exhausted retries.")


INVENTORY_SQL = """
SELECT jsonb_build_object(
 'server_version', current_setting('server_version'),
 'tables', (SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,
   'rows',(xpath('/row/c/text()',query_to_xml(format('select count(*) as c from only %I.%I',
     n.nspname,c.relname),false,true,'')))[1]::text::bigint) ORDER BY n.nspname,c.relname),'[]')
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE c.relkind IN ('r','p') AND n.nspname NOT LIKE 'pg_%'
     AND n.nspname <> 'information_schema'),
 'extensions', (SELECT jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion,
   'schema',n.nspname)) FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace),
 'policies', (SELECT jsonb_agg(to_jsonb(p)) FROM pg_policies p),
 'publications', (SELECT jsonb_agg(to_jsonb(p)) FROM pg_publication_tables p),
 'managed_triggers', (SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,
   'definition',pg_get_triggerdef(t.oid,true))) FROM pg_trigger t
   JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname IN ('auth','storage','realtime')),
 'vault_secret_count', (SELECT count(*) FROM vault.secrets)
);
"""
STORAGE_SQL = """
SELECT jsonb_build_object(
 'buckets',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.id),'[]') FROM storage.buckets b),
 'objects',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.bucket_id,o.name,o.id),'[]')
            FROM storage.objects o));
"""


def quoted_names(table):
    return (table["schema"], table["table"])


def validate_data_dump(path, inventory):
    found = set(re.findall(r'^COPY\s+"?([\w]+)"?\."?([\w]+)"?\s*\(', path.read_text(), re.MULTILINE))
    # Catch managed-schema exclusions, especially accidental loss of login records.
    required = {quoted_names(t) for t in inventory["tables"]
                if (t["schema"] not in MANAGED or
                    t["schema"] == "auth" and t["table"] != "schema_migrations")
                and t["rows"] > 0}
    if not required.issubset(found):
        raise BackupError("Data dump omitted populated application/Auth tables; backup is incomplete.")


def export_database(payload, cli, env, db_url, inventory):
    folder = payload / "database"
    folder.mkdir()
    data_schemas = sorted({t["schema"] for t in inventory["tables"]
                           if t["schema"] not in MANAGED or t["schema"] in ("auth", "storage")})
    commands = [
        ("roles.sql", ["--role-only"]),
        ("schema.sql", []),
        ("data.sql", ["--data-only", "--use-copy", "--schema", ",".join(data_schemas),
                      "--exclude", "storage.buckets_vectors,storage.vector_indexes"]),
        # Reference copy also preserves custom managed-schema objects which a default dump excludes.
        ("managed-schema-reference.sql", ["--schema", "auth,storage,realtime,vault"]),
        ("history-schema.sql", ["--schema", "supabase_migrations"]),
        ("history-data.sql", ["--data-only", "--use-copy", "--schema", "supabase_migrations"]),
    ]
    for name, flags in commands:
        run([cli, "db", "dump", "--db-url", db_url, "--file", str(folder / name), *flags],
            env=env, cwd=payload)
        if not (folder / name).is_file() or (folder / name).stat().st_size == 0:
            raise BackupError("Database export produced a missing or empty SQL file.")
    validate_data_dump(folder / "data.sql", inventory)
    write_json(folder / "catalog.json", inventory)


def read_checkpoint(archive, private, passphrase):
    """Decrypt an authenticated checkpoint; extract only verified numeric object files."""
    homedir = private / "resume-gpg"
    homedir.mkdir(mode=0o700)
    decrypted = private / "resume.tar.gz"
    run(["gpg", "--homedir", str(homedir), "--batch", "--yes", "--pinentry-mode", "loopback",
         "--no-symkey-cache", "--passphrase-fd", "0", "--output", str(decrypted),
         "--decrypt", str(archive)], input_bytes=(passphrase + "\n").encode())
    folder = private / "resume-objects"
    folder.mkdir(mode=0o700)
    try:
        with tarfile.open(decrypted) as tar:
            members = {}
            for member in tar.getmembers():
                if member.name in members:
                    raise BackupError("Checkpoint contains duplicate archive members.")
                members[member.name] = member
            def json_member(name, expected=None):
                member = members["liminal-backup/" + name]
                if not member.isfile():
                    raise BackupError("Checkpoint metadata must contain ordinary files.")
                raw = tar.extractfile(member).read()
                if expected is not None and hashlib.sha256(raw).hexdigest() != expected.get(name):
                    raise BackupError("Checkpoint metadata checksum differs.")
                return json.loads(raw)
            checksums = json_member("checksums.json")
            manifest = json_member("backup-manifest.json", checksums)
            if manifest.get("source_project") != SETTINGS["projectRef"]:
                raise BackupError("Checkpoint belongs to a different source project.")
            entries = json_member("storage/downloaded-manifest.json", checksums)
            if not isinstance(entries, list):
                raise BackupError("Checkpoint has no verified Storage file manifest.")
            cache = {}
            for entry in sorted(entries, key=lambda item: item["file"]):
                name, obj = entry["file"], entry["source"]
                if not re.fullmatch(r"storage/objects/[0-9]{8,}\.bin", name):
                    raise BackupError("Checkpoint object paths must use numeric local names.")
                if not isinstance(obj.get("id"), str) or obj["id"] in cache:
                    raise BackupError("Checkpoint object identity is invalid or repeated.")
                member = members["liminal-backup/" + name]
                if not member.isfile() or member.size != entry["bytes"]:
                    raise BackupError("Checkpoint object file is invalid or truncated.")
                destination = folder / Path(name).name
                with tar.extractfile(member) as source, destination.open("wb") as target:
                    shutil.copyfileobj(source, target)
                actual = digest(destination)
                if actual != entry["sha256"] or actual != checksums.get(name):
                    raise BackupError("Checkpoint object checksum differs.")
                cache[obj["id"]] = {**entry, "cached_path": destination}
            return cache
    except (tarfile.TarError, OSError, KeyError, TypeError, ValueError, AttributeError):
        raise BackupError("Checkpoint could not be validated; no unverified files were reused.") from None


def export_objects(payload, manifest, api, cache=None):
    folder = payload / "storage" / "objects"
    folder.mkdir(parents=True)
    objects = manifest["objects"]
    cache = cache or {}
    write_json(payload / "storage/source-manifest.json", manifest)

    def download(pair):
        index, obj = pair
        bucket = urllib.parse.quote(obj["bucket_id"], safe="")
        path = "/".join(urllib.parse.quote(p, safe="") for p in obj["name"].split("/"))
        # Numeric local names prevent remote object paths from escaping the staging directory.
        local = folder / (str(index).zfill(8) + ".bin")
        route = "/storage/v1/object/" + bucket + "/" + path + "?liminal_migration=1"
        previous = cache.get(obj["id"])
        reused = bool(previous and all(previous["source"].get(k) == obj.get(k) for k in OBJECT_FIELDS))
        if reused:
            shutil.copyfile(previous["cached_path"], local)
            result = {"bytes": local.stat().st_size, "sha256": digest(local)}
            if result["sha256"] != previous["sha256"]:
                raise BackupError("A cached object changed after checkpoint verification.")
        else:
            result = api.fetch(route, local)
        expected = (obj.get("metadata") or {}).get("size")
        if expected is not None and result["bytes"] != int(expected):
            raise BackupError("An attachment's byte count differs from its database metadata.")
        return {"source": obj, "file": local.relative_to(payload).as_posix(), "reused": reused, **result}

    # A small source pool can saturate even with six simultaneous downloads.
    # Serial requests also stop promptly on failure instead of draining queued work.
    entries = []
    try:
        for pair in enumerate(objects):
            entries.append(download(pair))
            if len(entries) % 100 == 0 or len(entries) == len(objects):
                print("Storage export: " + str(len(entries)) + "/" + str(len(objects)) +
                      " files verified.", flush=True)
    finally:
        write_json(payload / "storage/downloaded-manifest.json", entries)
    return entries


def changed_objects(before, after):
    live = {obj["id"]: obj for obj in after["objects"]}
    old_ids = {obj["id"] for obj in before["objects"]}
    return len(set(live) - old_ids) + sum(1 for obj in before["objects"]
               if obj["id"] not in live or any(obj.get(k) != live[obj["id"]].get(k) for k in OBJECT_FIELDS))


def export_management(payload, api, cli, env):
    ref = SETTINGS["projectRef"]
    prefix = "/v1/projects/" + ref
    routes = {"project": prefix, "auth": prefix + "/config/auth",
              "realtime": prefix + "/config/realtime", "storage": prefix + "/config/storage",
              "postgrest": prefix + "/postgrest", "secret-inventory": prefix + "/secrets"}
    for name, route in routes.items():
        try:
            value = api.fetch(route)
        except BackupError as error:
            raise BackupError("Configuration export failed for " + name + ": " + str(error)) from None
        write_json(payload / "configuration" / (name + ".json"), value)
    functions = api.fetch(prefix + "/functions")
    if not isinstance(functions, list):
        raise BackupError("Function inventory did not return a complete list.")
    write_json(payload / "configuration/functions.json", functions)
    for function in functions:
        slug = function["slug"]
        if not re.fullmatch(r"[A-Za-z0-9_-]+", slug):
            raise BackupError("Invalid function slug in source inventory.")
        run([cli, "functions", "download", slug, "--project-ref", ref, "--use-api"], env=env, cwd=payload)
        directory = payload / "supabase" / "functions" / slug
        if not directory.is_dir() or not any(p.is_file() for p in directory.rglob("*")):
            raise BackupError("A deployed function's source files were not downloaded.")
    final = api.fetch(prefix + "/functions")
    signature = lambda items: sorted((f["slug"], f.get("version"), f.get("ezbr_sha256")) for f in items)
    if signature(final) != signature(functions):
        raise BackupError("Backend source changed during export; take another backup.")
    return len(functions)


def export_snippets(payload, api):
    """Save SQL Editor queries separately from installed database definitions."""
    entries, ids, cursors = [], set(), set()
    cursor = None
    folder = payload / "sql-editor"
    folder.mkdir()
    while True:
        params = {"project_ref": SETTINGS["projectRef"], "limit": "100"}
        if cursor:
            params["cursor"] = cursor
        page = api.fetch("/v1/snippets?" + urllib.parse.urlencode(params))
        if not isinstance(page, dict) or not isinstance(page.get("data"), list):
            raise BackupError("Saved SQL query inventory was not returned completely.")
        for item in page["data"]:
            snippet_id = item.get("id") if isinstance(item, dict) else None
            if not isinstance(snippet_id, str) or not snippet_id or snippet_id in ids:
                raise BackupError("Saved SQL query inventory contains an invalid or repeated ID.")
            detail = api.fetch("/v1/snippets/" + urllib.parse.quote(snippet_id, safe=""))
            content = detail.get("content") if isinstance(detail, dict) else None
            sql = content.get("sql") if isinstance(content, dict) else None
            if not isinstance(detail, dict) or detail.get("id") != snippet_id or not isinstance(sql, str):
                raise BackupError("A saved SQL query's content was not returned.")
            name = str(len(entries)).zfill(8)
            write_json(folder / (name + ".json"), detail)
            (folder / (name + ".sql")).write_text(sql)
            ids.add(snippet_id)
            entries.append({"metadata": item, "file": name + ".sql"})
        write_json(folder / "index.json", entries)
        cursor = page.get("cursor")
        if not cursor:
            return len(entries)
        if not isinstance(cursor, str) or cursor in cursors:
            raise BackupError("Saved SQL query pagination did not finish.")
        cursors.add(cursor)


def encrypt_archive(payload, private, destination, passphrase):
    archive = private / "backup.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(payload, arcname="liminal-backup", recursive=True)
    partial = destination.with_suffix(destination.suffix + ".partial")
    args = ["gpg", "--homedir", str(private / "gpg"), "--batch", "--yes", "--pinentry-mode", "loopback",
            "--no-symkey-cache", "--passphrase-fd", "0"]
    (private / "gpg").mkdir(mode=0o700, exist_ok=True)
    secret = passphrase.encode() + b"\n"
    run([*args, "--symmetric", "--cipher-algo", "AES256", "--s2k-digest-algo", "SHA512",
         "--s2k-mode", "3", "--s2k-count", "65011712", "--compress-algo", "none",
         "--output", str(partial), str(archive)], input_bytes=secret)
    verification = private / "verified.tar.gz"
    run([*args, "--output", str(verification), "--decrypt", str(partial)], input_bytes=secret)
    if digest(verification) != digest(archive):
        raise BackupError("Encrypted archive did not pass decryption verification.")
    partial.replace(destination)


def perform(output_dir, env, *, bootstrap=False, metadata_only=False, resume_archive=None):
    if metadata_only and resume_archive:
        raise BackupError("A configuration-only export cannot resume a Storage checkpoint.")
    pg = credentials(env, metadata_only=metadata_only)
    for program in (("gpg", "git") if metadata_only else ("psql", "gpg", "git")):
        if not shutil.which(program):
            raise BackupError("Required program is unavailable: " + program)
    output_dir.mkdir(parents=True, exist_ok=True)
    backup = output_dir / "liminal-backup.tar.gz.gpg"
    if backup.exists() or (output_dir / "summary.json").exists():
        raise BackupError("Use a fresh output directory; existing backups are never overwritten.")
    summary = {"status": "incomplete", "started_at": now(), "files": 0, "bytes": 0,
               "database_exported": False, "functions": 0, "reused_files": 0}
    failure = None
    with tempfile.TemporaryDirectory(prefix="liminal-private-backup-") as temporary:
        private = Path(temporary)
        private.chmod(0o700)
        payload = private / "payload"
        payload.mkdir(mode=0o700)
        child_env = {**env, **pg, "SUPABASE_ACCESS_TOKEN": env["LIMINAL_SOURCE_ACCESS_TOKEN"]}
        try:
            tools = private / "tools"
            tools.mkdir()
            cli = install_cli(tools) if bootstrap else shutil.which("supabase")
            if not cli:
                raise BackupError("Supabase CLI is unavailable; use --bootstrap-cli.")
            # Help is checked against the installed release before using its flags.
            run([cli, "db", "dump", "--help"], env=child_env, cwd=payload)
            run([cli, "functions", "download", "--help"], env=child_env, cwd=payload)
            # A fresh config prevents upward discovery of an unrelated local project/env file.
            run([cli, "init", "--workdir", str(payload), "--agent", "no"], env=child_env, cwd=payload)
            cache = read_checkpoint(resume_archive, private, env["LIMINAL_BACKUP_PASSPHRASE"]) if resume_archive else {}
            if not metadata_only:
                inventory = query(INVENTORY_SQL, child_env)
                objects = query(STORAGE_SQL, child_env)
                if inventory.get("vault_secret_count", 0):
                    raise BackupError("Vault contains encrypted secrets: its root key must be preserved before this export can be marked complete.")
                summary["component"] = "database"
                export_database(payload, cli, child_env, env["LIMINAL_SOURCE_DB_URL"], inventory)
                summary["database_exported"] = True
                summary["component"] = "storage"
                api = Api(SETTINGS["projectUrl"], storage_headers(env["LIMINAL_SOURCE_STORAGE_KEY"]))
                entries = export_objects(payload, objects, api, cache=cache)
                summary["files"] = len(entries)
                summary["bytes"] = sum(entry["bytes"] for entry in entries)
                final_objects = query(STORAGE_SQL, child_env)
                write_json(payload / "storage/final-source-manifest.json", final_objects)
                changes = changed_objects(objects, final_objects)
                if changes:
                    summary["source_changes"] = changes
                    raise BackupError("Source attachments were added, changed or deleted during the copy; take another backup during a quiet period.")
            summary["component"] = "functions-and-configuration"
            management = Api("https://api.supabase.com", {"Authorization": "Bearer " + env["LIMINAL_SOURCE_ACCESS_TOKEN"]})
            summary["functions"] = export_management(payload, management, cli, child_env)
            summary["component"] = "saved-sql-queries"
            summary["snippets"] = export_snippets(payload, management)
            run(["git", "archive", "HEAD"], cwd=ROOT, output=payload / "repository-source.tar")
            summary["status"] = "metadata-exported" if metadata_only else "exported"
            summary.pop("component", None)
        except BackupError as error:
            failure = error
            write_json(payload / "export-failure.json", {"message": str(error), "component": summary.get("component", "preflight")})
        finally:
            downloaded = payload / "storage/downloaded-manifest.json"
            if downloaded.is_file():
                entries = json.loads(downloaded.read_text())
                summary["files"] = len(entries)
                summary["bytes"] = sum(entry["bytes"] for entry in entries)
                summary["reused_files"] = sum(bool(entry.get("reused")) for entry in entries)
            summary["finished_at"] = now()
            write_json(payload / "backup-manifest.json", {**summary, "source_project": SETTINGS["projectRef"],
                "not_a_cutover": True,
                "manual_steps": ["Re-enter custom Edge Function secret values; the inventory may contain only digests.",
                    "Restore managed-schema customizations selectively, not the entire reference schema.",
                    "Existing R2 Drive files remain in their original R2 bucket; reconfigure its credentials.",
                    "Private SQL Editor queries owned by other team members require their own export.",
                    "Take a final synchronized export before switching traffic; online writes after this export are not included.",
                    "Validate the restored destination before treating this as a proven recovery backup."]})
            checksums = {}
            for path in sorted(payload.rglob("*")):
                if path.is_symlink():
                    raise BackupError("Symlinks are not allowed in backup payloads.")
                if path.is_file():
                    checksums[path.relative_to(payload).as_posix()] = digest(path)
            write_json(payload / "checksums.json", checksums)
            encrypt_archive(payload, private, backup, env["LIMINAL_BACKUP_PASSPHRASE"])
            summary["encrypted_sha256"] = digest(backup)
            write_json(output_dir / "summary.json", summary)
    if failure:
        raise failure
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--bootstrap-cli", action="store_true")
    parser.add_argument("--metadata-only", action="store_true", help="Only export configuration, functions and saved SQL queries.")
    parser.add_argument("--resume", type=Path, help="Reuse unchanged verified files from an encrypted source checkpoint.")
    parser.add_argument("--output-dir", type=Path, default=Path("migration-output"))
    args = parser.parse_args()
    os.umask(0o077)
    try:
        credentials(os.environ, metadata_only=args.metadata_only)
        if args.preflight:
            print("Source identity and required secrets are configured.")
        else:
            summary = perform(args.output_dir.resolve(), dict(os.environ), bootstrap=args.bootstrap_cli,
                              metadata_only=args.metadata_only, resume_archive=args.resume)
            if args.metadata_only:
                print("Encrypted configuration export verified: " + str(summary["functions"]) +
                      " functions, " + str(summary["snippets"]) + " saved SQL queries.")
            else:
                print("Encrypted export verified: " + str(summary["files"]) + " files. Destination restore still required.")
        return 0
    except BackupError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        print("Backup stopped after an unexpected error. No raw diagnostics were published; inspect any encrypted partial export.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
