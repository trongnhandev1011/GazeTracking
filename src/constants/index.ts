import type { KeyDef } from "../types";

export const KEY_LAYOUT: KeyDef[][] = [
  [
    { id: "row1-1", label: "1", value: "1" },
    { id: "row1-2", label: "2", value: "2" },
    { id: "row1-3", label: "3", value: "3" },
    { id: "row1-4", label: "4", value: "4" },
    { id: "row1-5", label: "5", value: "5" },
    { id: "row1-6", label: "6", value: "6" },
    { id: "row1-7", label: "7", value: "7" },
    { id: "row1-8", label: "8", value: "8" },
    { id: "row1-9", label: "9", value: "9" },
    { id: "row1-0", label: "0", value: "0" },
  ],
  [
    { id: "r2-q", label: "Q" },
    { id: "r2-w", label: "W" },
    { id: "r2-e", label: "E" },
    { id: "r2-r", label: "R" },
    { id: "r2-t", label: "T" },
    { id: "r2-y", label: "Y" },
    { id: "r2-u", label: "U" },
    { id: "r2-i", label: "I" },
    { id: "r2-o", label: "O" },
    { id: "r2-p", label: "P" },
  ],
  [
    { id: "r3-a", label: "A" },
    { id: "r3-s", label: "S" },
    { id: "r3-d", label: "D" },
    { id: "r3-f", label: "F" },
    { id: "r3-g", label: "G" },
    { id: "r3-h", label: "H" },
    { id: "r3-j", label: "J" },
    { id: "r3-k", label: "K" },
    { id: "r3-l", label: "L" },
    { id: "r3-back", label: "⌫", special: true, wide: true },
  ],
  [
    { id: "r4-z", label: "Z" },
    { id: "r4-x", label: "X" },
    { id: "r4-c", label: "C" },
    { id: "r4-v", label: "V" },
    { id: "r4-b", label: "B" },
    { id: "r4-n", label: "N" },
    { id: "r4-m", label: "M" },
    { id: "r4-enter", label: "⏎", special: true, wide: true },
  ],
  [
    {
      id: "r5-space-left",
      label: "Space",
      value: " ",
      special: true,
      wide: true,
      role: "space-left",
    },
    {
      id: "r5-space-suggest",
      label: "",
      special: true,
      wide: true,
      role: "space-suggest",
    },
  ],
];

export const ALL_KEYS = KEY_LAYOUT.flat();