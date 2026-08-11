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
 * Ink that stays readable on a group colour. Compare both candidates by WCAG
 * contrast instead of relying on a luminance cutoff that fails mid-tone groups.
 */
export function inkOn(color: string): string {
  const DARK_INK = "#15180f";
  const hex = color.replace("#", "");
  const luminance = (value: string) => {
    const channel = (index: number) => {
      const component = parseInt(value.slice(index * 2, (index * 2) + 2), 16) / 255;
      return component <= 0.03928 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
    };
    return (0.2126 * channel(0)) + (0.7152 * channel(1)) + (0.0722 * channel(2));
  };
  const contrast = (first: number, second: number) => {
    const lighter = Math.max(first, second);
    const darker = Math.min(first, second);
    return (lighter + 0.05) / (darker + 0.05);
  };
  const background = luminance(hex);
  const dark = luminance(DARK_INK.slice(1));
  return contrast(background, dark) >= contrast(background, 1) ? DARK_INK : "#ffffff";
}
