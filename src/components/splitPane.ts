// SplitSizes describes persistent divider preferences independently of measured layout geometry.

/** Preferred first-pane extents; pixels stay fixed while percentages follow the available space. */
export interface SplitSizes {
  /** Preference used while the two regions are side by side; clamping never changes this value. */
  horizontal: number | `${number}%`;
  /** Independent preference used while the two regions are stacked vertically. */
  vertical: number | `${number}%`;
}
