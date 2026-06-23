/**
 * Deep merge utility function that recursively merges objects.
 * Arrays are replaced, not merged.
 *
 * @param target - The target object to merge into
 * @param sources - Source objects to merge from
 * @returns The merged object
 */
export function mergeDeep<T extends Record<string, any>>(
  target: T,
  ...sources: Array<Partial<T> | undefined>
): T {
  if (!sources.length) return target;
  const source = sources.shift();

  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        mergeDeep(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }

  return mergeDeep(target, ...sources);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
}
