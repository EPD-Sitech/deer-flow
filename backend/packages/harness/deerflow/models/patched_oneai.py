"""Patched ChatOpenAI adapter for the oneai transit relay.

The oneai relay (``https://oneai.teamshub.com/v1``) echoes the *full* ``usage``
object in **every** streaming chunk for some models (e.g. ``Nines-N3.1``),
instead of following the OpenAI convention of sending it only on the final
chunk.

Why the naive fix is not enough
-------------------------------
``langchain_core``'s ``AIMessageChunk.__add__`` *sums* ``usage_metadata`` across
the streamed chunks (``add_usage`` in ``langchain_core/messages/ai.py``). So a
run that streams N chunks ends up with ``N * usage`` on the final
``AIMessage`` — which is exactly what DeerFlow's journal reads in
``on_llm_end``. Overriding ``_combine_llm_outputs`` does **not** help here,
because that only affects ``llm_output`` (``generation_info``), not the
message's own ``usage_metadata``.

Fix
---
Keep ``usage_metadata`` on only the *first* chunk that carries it and strip it
from every subsequent (duplicate) chunk, so the chunk concatenation sums it
exactly once. The flag is reset at the start of every stream so a model
instance reused across many calls within a run still counts each call once.
"""

from __future__ import annotations

from langchain_core.outputs import ChatGenerationChunk
from langchain_openai import ChatOpenAI


class PatchedChatONEAI(ChatOpenAI):
    """ChatOpenAI that does not multiply streaming ``usage`` across chunks."""

    @classmethod
    def is_lc_serializable(cls) -> bool:
        return True

    # -- Per-stream duplication guard -------------------------------------

    def _reset_oneai_usage_seen(self) -> None:
        # Set on the instance; reset before every stream so repeated calls
        # within one run each count their own usage exactly once.
        self._oneai_usage_seen = False  # type: ignore[attr-defined]

    def _stream(self, *args, **kwargs):  # type: ignore[override]
        self._reset_oneai_usage_seen()
        yield from super()._stream(*args, **kwargs)

    async def _astream(self, *args, **kwargs):  # type: ignore[override]
        self._reset_oneai_usage_seen()
        async for chunk in super()._astream(*args, **kwargs):
            yield chunk

    # -- Strip duplicated per-chunk usage ----------------------------------

    def _convert_chunk_to_generation_chunk(
        self,
        chunk: dict,
        default_chunk_class: type,
        base_generation_info: dict | None,
    ) -> ChatGenerationChunk | None:
        generation_chunk = super()._convert_chunk_to_generation_chunk(chunk, default_chunk_class, base_generation_info)
        if generation_chunk is None:
            return None

        msg = generation_chunk.message
        usage = getattr(msg, "usage_metadata", None)
        if not usage:
            return generation_chunk

        if getattr(self, "_oneai_usage_seen", False):
            # Duplicate usage from a later chunk — drop it so the final
            # AIMessage's usage_metadata is summed only once.
            return ChatGenerationChunk(
                message=msg.model_copy(update={"usage_metadata": None}),
                generation_info=generation_chunk.generation_info,
            )

        self._oneai_usage_seen = True  # type: ignore[attr-defined]
        return generation_chunk

    # -- Defense in depth for the llm_output path -------------------------
    # ``_combine_llm_outputs`` feeds ``generation_info``/``response.llm_output``
    # (not the journal's message.usage_metadata), but keep it correct too:
    # take the last non-empty token_usage instead of summing all chunks.

    def _combine_llm_outputs(self, llm_outputs: list[dict | None]) -> dict:
        combined = super()._combine_llm_outputs(llm_outputs)
        last_usage: dict | None = None
        for output in llm_outputs or []:
            if not isinstance(output, dict):
                continue
            token_usage = output.get("token_usage")
            if isinstance(token_usage, dict) and token_usage:
                last_usage = token_usage
        if last_usage is not None:
            combined = {**combined, "token_usage": last_usage}
        return combined
