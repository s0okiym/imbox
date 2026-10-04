const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const promotionDefinitions = {
  PromoteRunInput: obj({
    task: ref('CreateTaskInput'),
    confirm_new_authorization: { const: true },
  }),
  TaskRunOrigin: {
    oneOf: [
      obj({ access: { const: 'none' } }),
      obj({ access: { const: 'restricted' } }),
      obj({
        access: { const: 'available' },
        run_id: ref('Identifier'),
        run_version: ref('Version'),
        conversation_id: ref('Identifier'),
        context_manifest_id: ref('Identifier'),
        created_at: ref('UtcTimestamp'),
      }),
    ],
  },
};
