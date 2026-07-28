"""Size-capped reading of recipe photos.

Both photo paths - a browser upload and a download of the image an imported
recipe points at - accept bytes from somewhere we do not control, so the 10 MB
cap has to hold against a body that lies about its size or never ends.

Checking the length after the fact does not do that: by then the whole body is
already in memory, which is the thing the cap exists to prevent. So the bytes
are consumed a chunk at a time and the read is abandoned the moment the total
goes over. Content-Length, when a server sends one, only lets us skip the
transfer entirely; it is a courtesy, never the enforcement.
"""

from collections.abc import AsyncIterator

from fastapi import UploadFile

CHUNK_BYTES = 64 * 1024


class ImageTooLarge(Exception):
    """Raised as soon as the byte count passes the cap, before it is buffered."""


async def read_capped(chunks: AsyncIterator[bytes], limit: int) -> bytes:
    """Collect ``chunks`` into bytes, raising ImageTooLarge past ``limit``.

    The check runs per chunk, so at most one chunk more than the limit is ever
    held. The caller is expected to close the underlying stream."""
    buffer = bytearray()
    async for chunk in chunks:
        buffer.extend(chunk)
        if len(buffer) > limit:
            raise ImageTooLarge
    return bytes(buffer)


async def upload_chunks(file: UploadFile) -> AsyncIterator[bytes]:
    """A multipart upload as a chunk stream, so it reads like any other."""
    while chunk := await file.read(CHUNK_BYTES):
        yield chunk


def declared_length_exceeds(content_length: str | None, limit: int) -> bool:
    """Whether a Content-Length header already rules the body out.

    Only ever used to skip a transfer we know we would reject; a missing,
    malformed, or dishonest value falls through to the streaming cap."""
    try:
        return content_length is not None and int(content_length) > limit
    except ValueError:
        return False
