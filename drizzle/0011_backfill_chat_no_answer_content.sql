UPDATE "chat_messages"
SET "answer_document" = jsonb_set(
  "answer_document" - 'status',
  '{content}',
  to_jsonb("content"),
  true
)
WHERE "role" = 'assistant'
  AND "answer_document" IS NOT NULL
  AND jsonb_array_length("answer_document"->'citations') = 0
  AND jsonb_array_length("answer_document"->'statements') = 0
  AND NOT "answer_document" ? 'content';
