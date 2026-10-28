/**
 * Property lists as `plutil -convert xml1` writes them, and the NSKeyedArchiver archives
 * iOS keeps inside them: the notification store and the notification settings are both.
 */
export type PlistValue =
  | string
  | number
  | boolean
  | PlistValue[]
  | { [key: string]: PlistValue };

/**
 * An XML property list, parsed. Only what `plutil -convert xml1` writes: dict, array, key,
 * string, integer, real, true, false, data and date. Data and dates stay strings.
 */
export function parsePlistXml(xml: string): PlistValue {
  const tokens = [
    ...xml.matchAll(
      /<(\/?)([a-zA-Z0-9]+)(?:\s[^>]*?)?(\/?)>|([^<]+)|<[?!][^>]*>/g
    ),
  ];
  let i = 0;

  const nextTag = (): { name: string; closing: boolean; empty: boolean } => {
    while (i < tokens.length) {
      const token = tokens[i++];
      if (token[2]) {
        return {
          name: token[2],
          closing: token[1] === '/',
          empty: token[3] === '/',
        };
      }
    }
    throw new Error('plist ended early');
  };
  const text = (name: string): string => {
    let value = '';
    while (i < tokens.length) {
      const token = tokens[i++];
      if (token[4] !== undefined) value += token[4];
      else if (token[2] === name && token[1] === '/')
        return decodeEntities(value);
    }
    throw new Error(`unclosed <${name}>`);
  };

  const value = (tag = nextTag()): PlistValue => {
    switch (tag.name) {
      case 'plist':
        return value();
      case 'dict': {
        const dict: { [key: string]: PlistValue } = {};
        if (tag.empty) return dict;
        for (;;) {
          const next = nextTag();
          if (next.closing && next.name === 'dict') return dict;
          if (next.name !== 'key')
            throw new Error(`<${next.name}> where a key belongs`);
          const key = next.empty ? '' : text('key');
          dict[key] = value();
        }
      }
      case 'array': {
        const array: PlistValue[] = [];
        if (tag.empty) return array;
        for (;;) {
          const next = nextTag();
          if (next.closing && next.name === 'array') return array;
          array.push(value(next));
        }
      }
      case 'string':
      case 'data':
      case 'date':
        return tag.empty ? '' : text(tag.name);
      case 'integer':
      case 'real':
        return tag.empty ? 0 : Number(text(tag.name));
      case 'true':
        return true;
      case 'false':
        return false;
      default:
        throw new Error(`unexpected <${tag.name}>`);
    }
  };

  return value();
}

function decodeEntities(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g,
    (_, hex, decimal, named) => {
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      if (decimal) return String.fromCodePoint(parseInt(decimal, 10));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[
        named as 'amp' | 'lt' | 'gt' | 'quot' | 'apos'
      ];
    }
  );
}

/**
 * An NSKeyedArchiver archive turned back into plain values: references followed, NSArray and
 * NSDictionary rebuilt, class markers dropped. Depth-limited, because an archive may refer
 * back to itself.
 */
export function unarchive(plist: PlistValue): unknown {
  const archive = plist as { [key: string]: PlistValue };
  const objects = archive.$objects as PlistValue[] | undefined;
  const top = archive.$top as { [key: string]: PlistValue } | undefined;
  if (!Array.isArray(objects) || !top) return undefined;

  const resolve = (value: PlistValue | undefined, depth: number): unknown => {
    if (depth > 24 || value === undefined) return undefined;
    if (isReference(value)) {
      const uid = (value as { [key: string]: PlistValue })['CF$UID'];
      return resolve(objects[uid as number], depth + 1);
    }
    if (value === '$null') return undefined;
    if (Array.isArray(value)) {
      return value.map((item) => resolve(item, depth + 1));
    }
    if (typeof value !== 'object') return value;

    const keys = value['NS.keys'];
    const values = value['NS.objects'];
    if (Array.isArray(keys) && Array.isArray(values)) {
      const dict: Record<string, unknown> = {};
      keys.forEach((key, index) => {
        dict[String(resolve(key, depth + 1))] = resolve(
          values[index],
          depth + 1
        );
      });
      return dict;
    }
    if (Array.isArray(values)) {
      return values.map((item) => resolve(item, depth + 1));
    }
    if (typeof value['NS.string'] === 'string') return value['NS.string'];

    const plain: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key !== '$class') plain[key] = resolve(item as PlistValue, depth + 1);
    }
    return plain;
  };

  return resolve(top.root, 0);
}

/** `{ CF$UID: n }`: a pointer into the archive's object table. */
function isReference(value: PlistValue): boolean {
  return (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value['CF$UID'] === 'number' &&
    Object.keys(value).length === 1
  );
}
