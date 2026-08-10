import hashlib
import os
from pathlib import Path
import tempfile
import unittest

from fastapi import HTTPException

from citeloom_docling.app import (
    ABANDONED_TASK_CONTENT_MAX_AGE_SECONDS,
    delete_task_content,
    reconcile_abandoned_task_content,
    reset_task_content_directory,
    resolve_task_content_path,
    store_task_content,
)


class StreamingRequest:
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks

    async def stream(self):
        for chunk in self.chunks:
            yield chunk


class TaskContentStoreTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.checkpoint_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.checkpoint_directory.name)
        self.task_id = "00000000-0000-4000-8000-000000000051"

    def tearDown(self) -> None:
        self.checkpoint_directory.cleanup()

    async def test_verifies_and_atomically_publishes_uploaded_content(
        self,
    ) -> None:
        content = b"storage-neutral Docling source"
        document_id = hashlib.sha256(content).hexdigest()

        published = await store_task_content(
            self.root,
            self.task_id,
            document_id,
            len(content),
            StreamingRequest([content[:10], content[10:]]),
        )

        self.assertEqual(published.read_bytes(), content)
        self.assertEqual(
            resolve_task_content_path(
                self.root,
                self.task_id,
                document_id,
            ),
            published,
        )
        self.assertEqual(list(published.parent.glob("*.tmp")), [])

    async def test_rejects_content_with_the_wrong_digest(self) -> None:
        content = b"incorrect source"

        with self.assertRaises(HTTPException) as raised:
            await store_task_content(
                self.root,
                self.task_id,
                "a" * 64,
                len(content),
                StreamingRequest([content]),
            )

        self.assertEqual(raised.exception.status_code, 422)
        task_directory = self.root / "source-content" / self.task_id
        self.assertFalse(task_directory.exists())

    async def test_deletes_task_content_after_release(self) -> None:
        content = b"completed task source"
        document_id = hashlib.sha256(content).hexdigest()
        await store_task_content(
            self.root,
            self.task_id,
            document_id,
            len(content),
            StreamingRequest([content]),
        )

        delete_task_content(self.root, self.task_id)

        self.assertFalse(
            (self.root / "source-content" / self.task_id).exists()
        )

    async def test_reconciles_only_old_unclaimed_task_content(self) -> None:
        content = b"abandoned task source"
        document_id = hashlib.sha256(content).hexdigest()
        await store_task_content(
            self.root,
            self.task_id,
            document_id,
            len(content),
            StreamingRequest([content]),
        )
        task_directory = self.root / "source-content" / self.task_id
        os.utime(task_directory, (0, 0))

        retained = reconcile_abandoned_task_content(
            self.root,
            {self.task_id},
            ABANDONED_TASK_CONTENT_MAX_AGE_SECONDS + 1,
        )
        removed = reconcile_abandoned_task_content(
            self.root,
            set(),
            ABANDONED_TASK_CONTENT_MAX_AGE_SECONDS + 1,
        )

        self.assertEqual(retained, 0)
        self.assertEqual(removed, 1)
        self.assertFalse(task_directory.exists())

    async def test_resets_staged_content_without_removing_checkpoints(
        self,
    ) -> None:
        content = b"restart cleanup source"
        document_id = hashlib.sha256(content).hexdigest()
        await store_task_content(
            self.root,
            self.task_id,
            document_id,
            len(content),
            StreamingRequest([content]),
        )
        checkpoint = self.root / "range-checkpoint.json"
        checkpoint.write_text("checkpoint")

        reset_task_content_directory(self.root)

        self.assertTrue((self.root / "source-content").is_dir())
        self.assertEqual(list((self.root / "source-content").iterdir()), [])
        self.assertEqual(checkpoint.read_text(), "checkpoint")


if __name__ == "__main__":
    unittest.main()
