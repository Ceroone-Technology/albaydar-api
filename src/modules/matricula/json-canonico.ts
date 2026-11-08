/** JSON con las claves ordenadas: `jsonb` no conserva el orden de las claves. */
export function jsonCanonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jsonCanonico).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jsonCanonico(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
