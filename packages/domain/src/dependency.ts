import { assertNonEmpty, DomainError } from './error.js';

export interface TaskDependency {
  readonly taskId: string;
  readonly dependsOnTaskId: string;
}

/** Returns a closed cycle path, or null. Does not mutate or recurse over the graph. */
export function findDependencyCycle(edges: readonly TaskDependency[]): readonly string[] | null {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    assertNonEmpty(edge.taskId, 'taskId');
    assertNonEmpty(edge.dependsOnTaskId, 'dependsOnTaskId');
    const neighbors = adjacency.get(edge.taskId) ?? new Set<string>();
    neighbors.add(edge.dependsOnTaskId);
    adjacency.set(edge.taskId, neighbors);
    if (!adjacency.has(edge.dependsOnTaskId))
      adjacency.set(edge.dependsOnTaskId, new Set<string>());
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  for (const root of adjacency.keys()) {
    if (visited.has(root)) continue;
    const stack: { readonly node: string; readonly iterator: SetIterator<string> }[] = [];
    stack.push({ node: root, iterator: (adjacency.get(root) ?? new Set<string>()).values() });
    active.add(root);
    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (frame === undefined) break;
      const next = frame.iterator.next();
      if (next.done) {
        stack.pop();
        active.delete(frame.node);
        visited.add(frame.node);
        continue;
      }
      if (active.has(next.value)) {
        const offset = stack.findIndex((entry) => entry.node === next.value);
        return [...stack.slice(offset).map((entry) => entry.node), next.value];
      }
      if (!visited.has(next.value)) {
        active.add(next.value);
        stack.push({
          node: next.value,
          iterator: (adjacency.get(next.value) ?? new Set<string>()).values(),
        });
      }
    }
  }
  return null;
}

/** The application must hold the tenant dependency-graph lock for cross-root changes. */
export function assertAcyclicDependencies(edges: readonly TaskDependency[]): void {
  const cycle = findDependencyCycle(edges);
  if (cycle !== null) throw new DomainError('DEPENDENCY_CYCLE', 409, { cycle });
}

export function addTaskDependency(
  edges: readonly TaskDependency[],
  edge: TaskDependency,
): readonly TaskDependency[] {
  const next = edges.some(
    (existing) =>
      existing.taskId === edge.taskId && existing.dependsOnTaskId === edge.dependsOnTaskId,
  )
    ? edges
    : [...edges, { ...edge }];
  assertAcyclicDependencies(next);
  return next;
}
