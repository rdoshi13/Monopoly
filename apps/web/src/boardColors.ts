/** The eight street groups. Shared so the board and the title deed cannot drift. */
export const groupColors: Record<string, string> = {
  Brown: "#955436",
  "Light Blue": "#aae0fa",
  Pink: "#d93a96",
  Orange: "#f7941d",
  Red: "#ed1b24",
  Yellow: "#fef200",
  Green: "#1fb25a",
  "Dark Blue": "#0072bb",
};

/** Railroads, Utilities and Special are not developable. */
export const isStreetGroup = (group: string) => group in groupColors;

/**
 * Ink that stays readable on a group colour. White is right for most of the
 * board but unreadable on Yellow and Light Blue, so pick by relative luminance
 * (WCAG) rather than maintaining a per-group exception list.
 */
export function inkOn(color: string): string {
  const hex = color.replace("#", "");
  const channel = (index: number) => {
    const value = parseInt(hex.slice(index * 2, (index * 2) + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (0.2126 * channel(0)) + (0.7152 * channel(1)) + (0.0722 * channel(2));
  return luminance > 0.45 ? "#15180f" : "#ffffff";
}
