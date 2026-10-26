// Implements the pure move operation shared by keyboard and pointer tab reordering.
import type { TabItem } from "./tabs";

/** Moves an existing tab before another ID, or to the end for null; invalid and ineffective moves retain the input. */
export function moveTab(
  items: readonly TabItem[],
  id: string,
  beforeId: string | null,
): readonly TabItem[] {
  const sourceIndex = items.findIndex(item => item.id === id);
  if (sourceIndex === -1 || id === beforeId) return items;
  if (beforeId !== null && !items.some(item => item.id === beforeId)) return items;

  const remaining = items.filter(item => item.id !== id);
  const targetIndex = beforeId === null
    ? remaining.length
    : remaining.findIndex(item => item.id === beforeId);
  if (targetIndex === sourceIndex) return items;

  return [
    ...remaining.slice(0, targetIndex),
    items[sourceIndex],
    ...remaining.slice(targetIndex),
  ];
}
