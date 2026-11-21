# Wire fixtures

These SSE/JSON payloads were **not** recorded from live provider accounts on the build
machine (no provider keys were available).
They are **docs-derived** snapshots assembled from the provider's published streaming
examples and the adapter contracts in this package, used to keep parsing/mapping tests
deterministic.

If a live capture is later taken from a real endpoint, replace the relevant file and
note the source here. The values inside them are illustrative, but they are **not**
free to edit: the adapter tests assert the fixture-derived text, tool ids/arguments and
token counts directly, so changing a fixture means updating its test alongside it.

| File | Shape |
| ---- | ----- |
| `openai-chat.sse` | OpenAI Chat Completions `chat.completion.chunk` stream (text + tool call, deltas split across chunks) |
| `openai-responses.sse` | OpenAI Responses stream (`response.output_text.delta`, `response.output_item.*` function call, `response.completed`) |
| `anthropic.sse` | Anthropic Messages stream (`message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`) |
