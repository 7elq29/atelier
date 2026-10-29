# Chat transcript shows the latest 50 conversations

Superseded by [`../chat-transcript-latest-50/spec.md`](../chat-transcript-latest-50/spec.md).
The display window is `CHAT_TRANSCRIPT_MAX_TURNS = 50` (was briefly 20 after an
earlier 40→20 tighten). Older turns remain in SQLite; only the UI window is capped.
