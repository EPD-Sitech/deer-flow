"""Tests for ``deerflow.models.patched_oneai.PatchedChatONEAI``.

Root cause
----------
The oneai relay repeats the full ``usage`` in *every* streaming chunk, and
``langchain_core`` sums ``usage_metadata`` while concatenating chunks. The patch
must therefore strip the duplicated ``usage_metadata`` at the *chunk* level (in
``_convert_chunk_to_generation_chunk``), so the final ``AIMessage`` ends up with
exactly one copy of the usage — not N copies.
"""

from __future__ import annotations

import pytest
from langchain_core.messages import AIMessageChunk
from langchain_core.outputs import ChatGenerationChunk

from deerflow.models.patched_oneai import PatchedChatONEAI


@pytest.fixture
def model() -> PatchedChatONEAI:
    return PatchedChatONEAI(openai_api_key="test-key")


def _raw_chunk(content: str, usage=None) -> dict:
    """Mimic a raw OpenAI-style streaming chunk as oneai sends it."""
    chunk: dict = {
        "id": "x",
        "object": "chat.completion.chunk",
        "model": "Nines-N3.1",
        "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": None}],
    }
    if usage is not None:
        chunk["usage"] = usage
    return chunk


def _usage(total: int = 120, inp: int = 100, out: int = 20) -> dict:
    return {"total_tokens": total, "prompt_tokens": inp, "completion_tokens": out}


def _convert(model: PatchedChatONEAI, chunk: dict) -> ChatGenerationChunk | None:
    return model._convert_chunk_to_generation_chunk(chunk, AIMessageChunk, {"model_name": "Nines-N3.1"})


def test_first_chunk_keeps_usage(model: PatchedChatONEAI) -> None:
    """The first chunk carrying usage keeps its usage_metadata."""
    out = _convert(model, _raw_chunk("hi", _usage()))
    assert out is not None
    assert out.message.usage_metadata is not None
    assert out.message.usage_metadata["total_tokens"] == 120


def test_duplicate_chunks_strip_usage(model: PatchedChatONEAI) -> None:
    """Every repeated usage chunk must have usage_metadata stripped to None."""
    first = _convert(model, _raw_chunk("a", _usage()))
    second = _convert(model, _raw_chunk("b", _usage()))
    third = _convert(model, _raw_chunk("c", _usage()))
    assert first.message.usage_metadata["total_tokens"] == 120
    assert second.message.usage_metadata is None
    assert third.message.usage_metadata is None


def test_concatenated_usage_not_summed(model: PatchedChatONEAI) -> None:
    """After concatenation the final AIMessage carries usage exactly once.

    This is the property that actually fixes the 784x token inflation.
    """
    converted = [
        _convert(model, _raw_chunk("a", _usage())),
        _convert(model, _raw_chunk("b", _usage())),
        _convert(model, _raw_chunk("c", _usage())),
    ]
    combined: AIMessageChunk | None = None
    for chunk in converted:
        assert chunk is not None
        combined = chunk.message if combined is None else combined + chunk.message
    assert isinstance(combined, AIMessageChunk)
    assert combined.usage_metadata is not None
    # Not 3 * 120 = 360 — must be exactly one copy.
    assert combined.usage_metadata["total_tokens"] == 120


def test_usage_reset_between_streams(model: PatchedChatONEAI) -> None:
    """A fresh stream (new _astream/_stream) re-arms the usage guard."""
    _convert(model, _raw_chunk("a", _usage()))
    _convert(model, _raw_chunk("b", _usage()))  # stripped
    model._reset_oneai_usage_seen()
    rearmed = _convert(model, _raw_chunk("c", _usage()))
    assert rearmed.message.usage_metadata is not None
    assert rearmed.message.usage_metadata["total_tokens"] == 120


def test_no_usage_passthrough(model: PatchedChatONEAI) -> None:
    """Chunks without usage are untouched."""
    out = _convert(model, _raw_chunk("plain"))
    assert out is not None
    assert out.message.usage_metadata is None


def test_combine_llm_outputs_takes_last(model: PatchedChatONEAI) -> None:
    """Defense in depth: llm_output path keeps the last, not the sum."""
    usage = {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120}
    llm_outputs = [None, {"token_usage": dict(usage)}, {"token_usage": dict(usage)}]
    combined = model._combine_llm_outputs(llm_outputs)
    assert combined["token_usage"] == usage
    assert combined["token_usage"]["total_tokens"] == 120
