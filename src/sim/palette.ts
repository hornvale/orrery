/** Terrain and star coloring, shared visually with the atlas map's elevation raster. */

function lerp(a: [number, number, number], b: [number, number, number], t: number) {
  const c = Math.min(1, Math.max(0, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * c),
    Math.round(a[1] + (b[1] - a[1]) * c),
    Math.round(a[2] + (b[2] - a[2]) * c),
  ] as [number, number, number];
}

/** The elevation raster's exact ramp: ocean blues by depth, land green→tan→brown→white. */
export function elevationColor(elevation: number, seaLevel: number): [number, number, number] {
  if (elevation < seaLevel) {
    return lerp([70, 130, 200], [10, 30, 80], (seaLevel - elevation) / 6000);
  }
  const height = elevation - seaLevel;
  if (height < 800) return lerp([60, 140, 70], [150, 160, 90], height / 800);
  if (height < 2500) return lerp([150, 160, 90], [140, 100, 70], (height - 800) / 1700);
  return lerp([140, 100, 70], [245, 245, 245], (height - 2500) / 2500);
}

/** Warm/cool RGB tint for a star, by the spectral letter in its class name. */
export function starTint(className: string): [number, number, number] {
  const m = className.match(/\(([OBAFGKM])\)/);
  switch (m?.[1]) {
    case "O":
    case "B":
      return [170, 200, 255];
    case "A":
      return [245, 245, 255];
    case "K":
      return [255, 180, 90];
    case "M":
      return [230, 110, 80];
    default:
      return [255, 214, 120]; // F / G / unknown
  }
}
