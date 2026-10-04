export const messageInteractionsSql=`
ALTER TABLE messages ADD COLUMN reply_to_version bigint CHECK(reply_to_version>0);
ALTER TABLE messages ADD CONSTRAINT messages_quote_version_requires_source CHECK(reply_to_version IS NULL OR reply_to_id IS NOT NULL);
CREATE INDEX messages_thread_idx ON messages(tenant_id,conversation_id,thread_root_id,seq);
CREATE INDEX reactions_message_idx ON reactions(tenant_id,message_id,id);
`;
