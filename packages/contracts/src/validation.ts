import { Ajv2020 } from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { ContractTypes } from './generated.js';
import {
  CONTRACT_SCHEMA_ID,
  schemaDocument,
  schemaNames,
  WIRE_LIMITS,
  PAGE_WIRE_LIMITS,
  type SchemaName,
} from './schemas.js';

export interface ValidationIssue {
  path: string;
  keyword: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

export class ContractValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(
    readonly schemaName: SchemaName,
    issues: ValidationIssue[],
  ) {
    super(`Invalid ${schemaName} contract`);
    this.name = 'ContractValidationError';
    this.issues = issues;
  }
}

const ajv = new Ajv2020({
  strict: true,
  allErrors: false,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  validateFormats: true,
  ownProperties: true,
});
// ajv-formats is CommonJS and exposes the plugin on its explicit default property.
formatsModule.default(ajv);
ajv.addSchema(schemaDocument);

const validators = new Map<SchemaName, ValidateFunction>();
for (const name of schemaNames) {
  const validator = ajv.getSchema(`${CONTRACT_SCHEMA_ID}#/$defs/${name}`);
  if (!validator) throw new Error(`Missing schema: ${name}`);
  validators.set(name, validator);
}

function issue(keyword: string, message: string): ValidationIssue[] {
  return [{ path: '', keyword, message }];
}

/** Reject dangerous/non-JSON values before Ajv or JSON.stringify can traverse them. */
function wireLimits(name: SchemaName) {
  return [
    'ExplicitMemoryPage',
    'RecoveryCasePage',
    'ArtifactCommentPage',
    'ArtifactSharePage',
    'NotificationPage',
    'NotificationDevicePage',
    'KnowledgeSearchPage',
    'StoredResourcePage',
    'StoredArtifactPage',
    'StoredArtifactVersionPage',
    'RuntimeRunPage',
    'MachineRunPage',
    'AgentDirectory',
    'MessagePage',
    'StreamSnapshot',
    'StreamEvents',
    'TaskPage',
    'CollaborationRequestPage',
    'SubmissionPage',
  ].includes(name)
    ? PAGE_WIRE_LIMITS
    : WIRE_LIMITS;
}

function checkWireValue(value: unknown, name: SchemaName): ValidationIssue[] | undefined {
  const limits = wireLimits(name);
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    const current = entry.value;
    if (entry.exit && typeof current === 'object' && current !== null) {
      ancestors.delete(current);
      continue;
    }
    nodes += 1;
    if (nodes > limits.maxNodes) return issue('maxNodes', 'JSON node limit exceeded');
    if (entry.depth > limits.maxDepth) return issue('maxDepth', 'JSON nesting limit exceeded');
    if (current === null || typeof current === 'boolean' || typeof current === 'string') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return issue('json', 'Numbers must be finite');
      continue;
    }
    if (typeof current !== 'object') return issue('json', 'Only JSON values are accepted');
    if (ancestors.has(current)) return issue('json', 'Cyclic values are not accepted');
    const isArray = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (
      (isArray && prototype !== Array.prototype) ||
      (!isArray && prototype !== Object.prototype && prototype !== null)
    ) {
      return issue('json', 'Only plain JSON objects are accepted');
    }
    ancestors.add(current);
    stack.push({ value: current, depth: entry.depth, exit: true });
    const descriptors = Object.getOwnPropertyDescriptors(current);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (isArray && key === 'length') continue;
      if (typeof key !== 'string') return issue('json', 'Symbol properties are not accepted');
      if (isArray && !/^(?:0|[1-9][0-9]*)$/.test(key))
        return issue('json', 'Non-index array properties are not accepted');
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        return issue('json', 'Accessors and hidden properties are not accepted');
      }
      stack.push({ value: descriptor.value, depth: entry.depth + 1 });
    }
  }
  const text = JSON.stringify(value);
  if (text === undefined) return issue('json', 'A JSON value is required');
  if (new TextEncoder().encode(text).byteLength > limits.maxBytes) {
    return issue('maxBytes', 'JSON payload byte limit exceeded');
  }
  return undefined;
}

function formatIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? 'Invalid value',
  }));
}

/** Validation does not coerce, remove fields, set defaults, authenticate, or authorize. */
export function validateContract<N extends SchemaName>(
  name: N,
  value: unknown,
): ValidationResult<ContractTypes[N]> {
  const wireIssues = checkWireValue(value, name);
  if (wireIssues) return { ok: false, issues: wireIssues };
  const validator = validators.get(name);
  if (!validator) throw new Error(`Unknown schema: ${name}`);
  if (!validator(value)) return { ok: false, issues: formatIssues(validator.errors) };
  return { ok: true, value: value as ContractTypes[N] };
}

export function assertContract<N extends SchemaName>(name: N, value: unknown): ContractTypes[N] {
  const result = validateContract(name, value);
  if (!result.ok) throw new ContractValidationError(name, result.issues);
  return result.value;
}

/** Raw transport boundary: enforce UTF-8 size before parsing (HTTP must also cap body bytes). */
export function parseContract<N extends SchemaName>(
  name: N,
  json: string,
): ValidationResult<ContractTypes[N]> {
  if (new TextEncoder().encode(json).byteLength > wireLimits(name).maxBytes) {
    return { ok: false, issues: issue('maxBytes', 'JSON payload byte limit exceeded') };
  }
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return { ok: false, issues: issue('json', 'Malformed JSON') };
  }
  return validateContract(name, value);
}
