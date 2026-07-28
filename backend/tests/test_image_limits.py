"""The 10 MB photo cap, on both the upload and the download path.

The point of these is not only that oversized images are rejected - it is that
they are rejected *without being read whole*. A cap enforced after the fact
still lets a caller put an arbitrary number of bytes in memory first, which is
the thing the cap exists to prevent, so the tests assert on how much of the
body the server consumed rather than only on the status code.
"""

import httpx
import pytest

from app.config import MAX_IMAGE_BYTES

PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDAT"
    b"x\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)

CHUNK = b"\x00" * (64 * 1024)


async def make_recipe(client) -> int:
    resp = await client.post("/api/recipes", json={"title": "Cake"})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


class FakeStream:
    """A response body handed out one chunk at a time, counting what was taken.

    ``total_chunks`` is what the server *could* read; ``taken`` is what it
    actually did. The gap between them is the whole point of streaming."""

    def __init__(self, total_chunks: int, headers: dict[str, str], status: int = 200):
        self.total_chunks = total_chunks
        self.headers = headers
        self.status = status
        self.taken = 0

    async def aiter_bytes(self):
        for _ in range(self.total_chunks):
            self.taken += 1
            yield CHUNK

    @property
    def bytes_taken(self) -> int:
        return self.taken * len(CHUNK)


@pytest.fixture
def fake_download(monkeypatch):
    """Install a streamed response for the next image-from-url call."""

    def install(stream: FakeStream) -> FakeStream:
        class Ctx:
            async def __aenter__(self):
                response = httpx.Response(
                    stream.status,
                    headers=stream.headers,
                    request=httpx.Request("GET", "https://example.com/photo.png"),
                )
                response.aiter_bytes = stream.aiter_bytes
                return response

            async def __aexit__(self, *exc):
                return False

        monkeypatch.setattr(
            httpx.AsyncClient, "stream", lambda self, method, url, **kw: Ctx()
        )
        return stream

    return install


async def test_download_stops_reading_once_past_the_cap(client, fake_download):
    """A body that keeps coming is abandoned just past the limit, not buffered
    to the end and measured afterwards."""
    over_by_far = (MAX_IMAGE_BYTES // len(CHUNK)) * 20
    stream = fake_download(
        FakeStream(total_chunks=over_by_far, headers={"content-type": "image/png"})
    )
    recipe_id = await make_recipe(client)

    resp = await client.post(
        f"/api/recipes/{recipe_id}/image-from-url",
        json={"url": "https://example.com/photo.png"},
    )

    assert resp.status_code == 413
    assert "10 MB" in resp.json()["detail"]
    # At most one chunk beyond the cap was ever held.
    assert stream.bytes_taken <= MAX_IMAGE_BYTES + len(CHUNK)
    assert stream.taken < stream.total_chunks


async def test_download_honours_an_oversized_content_length_without_reading(
    client, fake_download
):
    """When the server declares the size up front, skip the transfer entirely."""
    stream = fake_download(
        FakeStream(
            total_chunks=1000,
            headers={
                "content-type": "image/png",
                "content-length": str(MAX_IMAGE_BYTES + 1),
            },
        )
    )
    recipe_id = await make_recipe(client)

    resp = await client.post(
        f"/api/recipes/{recipe_id}/image-from-url",
        json={"url": "https://example.com/photo.png"},
    )

    assert resp.status_code == 413
    assert stream.taken == 0


async def test_download_ignores_a_lying_content_length(client, fake_download):
    """A small declared size does not buy a pass: the stream is still capped."""
    over = (MAX_IMAGE_BYTES // len(CHUNK)) + 4
    fake_download(
        FakeStream(
            total_chunks=over,
            headers={"content-type": "image/png", "content-length": "1024"},
        )
    )
    recipe_id = await make_recipe(client)

    resp = await client.post(
        f"/api/recipes/{recipe_id}/image-from-url",
        json={"url": "https://example.com/photo.png"},
    )

    assert resp.status_code == 413


async def test_download_rejects_bad_type_before_reading_the_body(client, fake_download):
    """Content-Type settles it from the headers, so nothing is downloaded."""
    stream = fake_download(
        FakeStream(total_chunks=1000, headers={"content-type": "image/svg+xml"})
    )
    recipe_id = await make_recipe(client)

    resp = await client.post(
        f"/api/recipes/{recipe_id}/image-from-url",
        json={"url": "https://example.com/photo.svg"},
    )

    assert resp.status_code == 415
    assert stream.taken == 0


async def test_download_accepts_an_image_under_the_cap(client, fake_download, images_dir):
    """The happy path still works, and writes the bytes it streamed."""

    class SmallStream(FakeStream):
        async def aiter_bytes(self):
            self.taken += 1
            yield PNG_BYTES

    fake_download(SmallStream(total_chunks=1, headers={"content-type": "image/png"}))
    recipe_id = await make_recipe(client)

    resp = await client.post(
        f"/api/recipes/{recipe_id}/image-from-url",
        json={"url": "https://example.com/photo.png"},
    )

    assert resp.status_code == 200, resp.text
    filename = resp.json()["image_filename"]
    assert filename.endswith(".png")
    assert (images_dir / filename).read_bytes() == PNG_BYTES


async def test_upload_rejects_a_file_over_the_cap(client):
    recipe_id = await make_recipe(client)
    oversized = b"\x89PNG\r\n\x1a\n" + b"\x00" * MAX_IMAGE_BYTES

    resp = await client.post(
        f"/api/recipes/{recipe_id}/image",
        files={"file": ("huge.png", oversized, "image/png")},
    )

    assert resp.status_code == 413
    assert "10 MB" in resp.json()["detail"]


async def test_upload_accepts_a_file_under_the_cap(client, images_dir):
    recipe_id = await make_recipe(client)

    resp = await client.post(
        f"/api/recipes/{recipe_id}/image",
        files={"file": ("small.png", PNG_BYTES, "image/png")},
    )

    assert resp.status_code == 200, resp.text
    assert (images_dir / resp.json()["image_filename"]).read_bytes() == PNG_BYTES
