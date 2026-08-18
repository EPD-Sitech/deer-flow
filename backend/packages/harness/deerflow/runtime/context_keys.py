"""Private runtime context keys shared across DeerFlow runtime components."""

from typing import Final

CURRENT_RUN_PRE_EXISTING_MESSAGE_IDS_KEY: Final[str] = "__deerflow_pre_run_message_ids"

# Carries the resolved per-user oneai transit model overrides
# (``{"api_key": ..., "base_url": ...}``) from the run worker to the lead-agent
# factory. Lives only in runtime context — never configurable/checkpoint — so
# the apiKey never touches persisted run state.
TRANSIT_MODEL_OVERRIDES_CONTEXT_KEY: Final[str] = "__deerflow_transit_model_overrides"
