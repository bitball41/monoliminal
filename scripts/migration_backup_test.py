import contextlib
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

import migration_backup as backup


def environment():
    return {"LIMINAL_SOURCE_DB_URL": "postgresql://postgres.ucgjwrjqmexenmrpbdkh:p%40ss@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
            "LIMINAL_SOURCE_STORAGE_KEY": "sb_secret_fixture", "LIMINAL_SOURCE_ACCESS_TOKEN": "sbp_fixture",
            "LIMINAL_BACKUP_PASSPHRASE": "migration-test-passphrase-123456789"}


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class Opener:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        value = next(self.responses)
        if isinstance(value, Exception):
            raise value
        return Response(value)


class MigrationTests(unittest.TestCase):
    def test_original_project_and_session_pooler_are_required(self):
        env = environment()
        self.assertEqual(backup.credentials(env)["PGPASSWORD"], "p@ss")
        for url in [env["LIMINAL_SOURCE_DB_URL"].replace(":5432/", ":6543/"),
                    env["LIMINAL_SOURCE_DB_URL"].replace("ucgjwrjqmexenmrpbdkh", "another-project"),
                    env["LIMINAL_SOURCE_DB_URL"] + "?sslmode=disable",
                    "postgresql://postgres:password@attacker.example/postgres"]:
            with self.subTest(url=url), self.assertRaises(backup.BackupError):
                backup.credentials({**env, "LIMINAL_SOURCE_DB_URL": url})

    def test_no_secret_value_in_missing_secret_error(self):
        env = environment()
        del env["LIMINAL_SOURCE_ACCESS_TOKEN"]
        with self.assertRaises(backup.BackupError) as caught:
            backup.credentials(env)
        self.assertIn("LIMINAL_SOURCE_ACCESS_TOKEN", str(caught.exception))
        self.assertNotIn("p%40ss", str(caught.exception))

    def test_command_failure_does_not_echo_credentials_or_response_body(self):
        import sys
        with self.assertRaises(backup.BackupError) as caught:
            backup.run([sys.executable, "-c", "import sys; print('SECRET',file=sys.stderr); sys.exit(1)"])
        self.assertNotIn("SECRET", str(caught.exception))

    def test_public_storage_key_is_rejected(self):
        with self.assertRaises(backup.BackupError):
            backup.storage_headers("sb_publishable_fixture")

    def test_redirect_does_not_forward_credentials(self):
        self.assertIsNone(backup.NoRedirect().redirect_request(None, None, 302, "", {}, "https://attacker.example"))

    def test_private_objects_are_downloaded_and_remote_paths_cannot_escape(self):
        opener = Opener([b"private image"])
        api = backup.Api("https://source.example", {"apikey": "secret"}, opener=opener)
        manifest = {"buckets": [{"id": "private", "public": False}], "objects": [
            {"id": "1", "bucket_id": "private", "name": "../../secret image.png", "metadata": {"size": 13}}]}
        with tempfile.TemporaryDirectory() as temp:
            payload = Path(temp)
            entries = backup.export_objects(payload, manifest, api)
            self.assertEqual((payload / entries[0]["file"]).read_bytes(), b"private image")
            self.assertEqual(entries[0]["file"], "storage/objects/00000000.bin")
            self.assertEqual(entries[0]["source"]["name"], "../../secret image.png")
            self.assertIn("/object/private/", opener.requests[0].full_url)
            self.assertNotIn("/object/public/", opener.requests[0].full_url)

    def test_incomplete_download_cannot_be_marked_successful(self):
        api = backup.Api("https://source.example", {}, opener=Opener([b"short"]))
        manifest = {"objects": [{"id": "1", "bucket_id": "private", "name": "file", "metadata": {"size": 100}}]}
        with tempfile.TemporaryDirectory() as temp, self.assertRaises(backup.BackupError):
            backup.export_objects(Path(temp), manifest, api)
            self.fail("A truncated attachment must stop the export")

    def test_rate_limit_retry_and_nonretryable_auth_failure(self):
        error = lambda code: urllib.error.HTTPError("https://source.example", code, "secret response", {}, None)
        opener = Opener([error(429), b'{"ok":true}'])
        pauses = []
        api = backup.Api("https://source.example", {}, opener=opener, pause=pauses.append)
        self.assertTrue(api.fetch("/route")["ok"])
        self.assertEqual(len(pauses), 1)
        api = backup.Api("https://source.example", {}, opener=Opener([error(401)]), pause=pauses.append)
        with self.assertRaisesRegex(backup.BackupError, "HTTP 401") as caught:
            api.fetch("/route")
        self.assertNotIn("secret response", str(caught.exception))

    def test_storage_pool_recovers_after_repeated_429_and_retry_after(self):
        errors = [urllib.error.HTTPError("https://source.example", 429, "private body",
                                         {"Retry-After": "20"}, None) for _ in range(5)]
        pauses = []
        api = backup.Api("https://source.example", {}, opener=Opener([*errors, b'{"ok":true}']),
                         pause=pauses.append)
        self.assertTrue(api.fetch("/route")["ok"])
        self.assertEqual(len(pauses), 5)
        self.assertTrue(all(delay >= 20 for delay in pauses))

    def test_storage_failure_preserves_verified_files_and_stops_queued_downloads(self):
        opener = Opener([b"saved", urllib.error.HTTPError("https://source.example", 404,
                                                       "private body", {}, None), b"unused"])
        api = backup.Api("https://source.example", {}, opener=opener)
        manifest = {"objects": [{"id": str(i), "bucket_id": "private", "name": str(i)} for i in range(3)]}
        with tempfile.TemporaryDirectory() as temp:
            payload = Path(temp)
            with self.assertRaises(backup.BackupError):
                backup.export_objects(payload, manifest, api)
            saved = json.loads((payload / "storage/downloaded-manifest.json").read_text())
            self.assertEqual(len(saved), 1)
            self.assertEqual((payload / saved[0]["file"]).read_bytes(), b"saved")
            self.assertEqual(len(opener.requests), 2)

    def test_missing_auth_rows_are_detected(self):
        inventory = {"tables": [{"schema": "auth", "table": "users", "rows": 75},
                                 {"schema": "private", "table": "examples", "rows": 5}]}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "data.sql"
            path.write_text('COPY "private"."examples" (id) FROM stdin;\n')
            with self.assertRaises(backup.BackupError):
                backup.validate_data_dump(path, inventory)
            path.write_text(path.read_text() + 'COPY auth.users (id) FROM stdin;\n')
            backup.validate_data_dump(path, inventory)

    def test_saved_queries_follow_pagination_and_keep_complete_sql(self):
        values = [{"data": [{"id": "first", "name": "../../saved query"}], "cursor": "next page"},
                  {"id": "first", "content": {"sql": "select 'unchanged SQL';\n"}},
                  {"data": [{"id": "second"}], "cursor": None},
                  {"id": "second", "content": {"sql": "select 'second query';"}}]
        opener = Opener([json.dumps(v).encode() for v in values])
        api = backup.Api("https://api.example", {}, opener=opener)
        with tempfile.TemporaryDirectory() as temp:
            payload = Path(temp)
            self.assertEqual(backup.export_snippets(payload, api), 2)
            self.assertEqual((payload / "sql-editor/00000000.sql").read_text(), "select 'unchanged SQL';\n")
            self.assertEqual((payload / "sql-editor/00000001.sql").read_text(), "select 'second query';")
            self.assertFalse((payload / "saved query").exists())
        first = backup.urllib.parse.parse_qs(backup.urllib.parse.urlsplit(opener.requests[0].full_url).query)
        next_page = backup.urllib.parse.parse_qs(backup.urllib.parse.urlsplit(opener.requests[2].full_url).query)
        self.assertEqual(first["project_ref"], [backup.SETTINGS["projectRef"]])
        self.assertEqual(next_page["cursor"], ["next page"])

    def test_saved_query_missing_content_and_repeated_cursor_are_incomplete(self):
        for values in ([{"data": [{"id": "first"}]}, {"id": "first", "content": {}}],
                       [{"data": [], "cursor": "same"}, {"data": [], "cursor": "same"}]):
            with self.subTest(values=values), tempfile.TemporaryDirectory() as temp:
                api = backup.Api("https://api.example", {}, opener=Opener([json.dumps(v).encode() for v in values]))
                with self.assertRaises(backup.BackupError):
                    backup.export_snippets(Path(temp), api)

    @unittest.skipUnless(shutil.which("gpg"), "GnuPG required")
    def test_metadata_companion_needs_no_database_or_storage_credentials(self):
        original_run = backup.run
        def commands(command, **kwargs):
            if command[0] == "gpg":
                return original_run(command, **kwargs)
            if kwargs.get("output"):
                kwargs["output"].write_bytes(b"tracked source fixture")
        env = {k: v for k, v in environment().items() if k in
               ("LIMINAL_SOURCE_ACCESS_TOKEN", "LIMINAL_BACKUP_PASSPHRASE")}
        with tempfile.TemporaryDirectory() as temp, \
             patch.object(backup.shutil, "which", return_value="fixture-tool"), \
             patch.object(backup, "install_cli", return_value="fixture-supabase"), \
             patch.object(backup, "run", side_effect=commands), \
             patch.object(backup, "query", side_effect=AssertionError("Database must not be queried")), \
             patch.object(backup, "export_objects", side_effect=AssertionError("Storage must not be queried")), \
             patch.object(backup, "export_management", return_value=2), \
             patch.object(backup, "export_snippets", return_value=3):
            summary = backup.perform(Path(temp) / "output", env, bootstrap=True, metadata_only=True)
            self.assertEqual(summary["status"], "metadata-exported")
            self.assertFalse(summary["database_exported"])
            self.assertEqual((summary["functions"], summary["snippets"]), (2, 3))

    def test_added_changed_or_deleted_files_require_another_export(self):
        obj = {"id": "1", "name": "file", "version": "a"}
        before = {"objects": [obj]}
        self.assertEqual(backup.changed_objects(before, {"objects": [obj, {"id": "2"}]}), 1)
        self.assertEqual(backup.changed_objects(before, {"objects": [{**obj, "version": "b"}]}), 1)
        self.assertEqual(backup.changed_objects(before, {"objects": []}), 1)

    @unittest.skipUnless(shutil.which("gpg"), "GnuPG required")
    def test_actual_encryption_roundtrip_and_no_plaintext_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            private = root / "private"
            private.mkdir()
            payload = private / "payload"
            payload.mkdir()
            (payload / "data.sql").write_text("private message and password hash fixture")
            destination = root / "backup.gpg"
            backup.encrypt_archive(payload, private, destination, environment()["LIMINAL_BACKUP_PASSPHRASE"])
            self.assertTrue(destination.is_file())
            self.assertFalse(destination.with_suffix(".gpg.partial").exists())
            self.assertNotIn(b"private message", destination.read_bytes())

    def test_public_workflow_only_uploads_encrypted_archive_and_safe_summary(self):
        text = (backup.ROOT / ".github/workflows/migration-backup.yml").read_text()
        artifact = text.split("name: Keep encrypted export", 1)[1].split("name: Remove runner", 1)[0]
        self.assertIn("liminal-backup.tar.gz.gpg", artifact)
        self.assertIn("summary.json", artifact)
        self.assertNotIn("*.sql", artifact)
        self.assertNotIn("payload", artifact)
        self.assertIn("github.event_name != 'pull_request'", text)

    @unittest.skipUnless(shutil.which("gpg"), "GnuPG required")
    def test_failed_export_keeps_only_encrypted_incomplete_output(self):
        original_run = backup.run

        def commands(command, **kwargs):
            if command[0] == "gpg":
                return original_run(command, **kwargs)
            if kwargs.get("output"):
                kwargs["output"].write_bytes(b"tracked source fixture")

        def database(payload, *args):
            (payload / "data.sql").write_text("sensitive fixture")

        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "output"
            with patch.object(backup.shutil, "which", return_value="fixture-tool"), \
                 patch.object(backup, "install_cli", return_value="fixture-supabase"), \
                 patch.object(backup, "run", side_effect=commands), \
                 patch.object(backup, "query", side_effect=[{"tables": []}, {"objects": []}, {"objects": []}]), \
                 patch.object(backup, "export_database", side_effect=database), \
                 patch.object(backup, "export_objects", return_value=[]), \
                 patch.object(backup, "export_management", side_effect=backup.BackupError("Function export failed.")):
                with self.assertRaises(backup.BackupError):
                    backup.perform(output, environment(), bootstrap=True)
            self.assertEqual({p.name for p in output.iterdir()}, {"summary.json", "liminal-backup.tar.gz.gpg"})
            summary = json.loads((output / "summary.json").read_text())
            self.assertEqual(summary["status"], "incomplete")
            self.assertTrue(summary["database_exported"])
            self.assertNotIn("sensitive fixture", (output / "summary.json").read_text())
            decrypted = Path(temp) / "check.tar.gz"
            original_run(["gpg", "--batch", "--pinentry-mode", "loopback", "--no-symkey-cache",
                          "--passphrase-fd", "0", "--output", str(decrypted), "--decrypt",
                          str(output / "liminal-backup.tar.gz.gpg")],
                         input_bytes=(environment()["LIMINAL_BACKUP_PASSPHRASE"] + "\n").encode())
            with tarfile.open(decrypted) as archive:
                manifest = json.load(archive.extractfile("liminal-backup/backup-manifest.json"))
                self.assertEqual(manifest["status"], "incomplete")
                self.assertEqual(archive.extractfile("liminal-backup/data.sql").read(), b"sensitive fixture")


if __name__ == "__main__":
    unittest.main()
