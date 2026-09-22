export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const suffix = "...";
  if (maxLength <= suffix.length) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - suffix.length)}${suffix}`;
}

export function appendBounded<T>(items: T[], item: T, maxItems: number): T[] {
  items.push(item);
  if (items.length > maxItems) {
    items.splice(0, items.length - maxItems);
  }
  return items;
}
